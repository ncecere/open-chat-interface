import { and, eq, isNull, schema } from '@oci/db';
import { type AcceptInviteInput, USER_ROLES, type UserRole } from '@oci/shared';
import { auth } from '../auth/index.js';
import { isEmailVerificationEnforced } from '../auth/policy.js';
import { db } from '../db/index.js';
import { hashToken } from '../lib/crypto.js';
import { conflict, forbidden, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { recordAudit } from './audit.js';
import { getSetting } from './settings.js';

const INVALID_INVITE_MESSAGE = 'This invitation is invalid or no longer available';

function validRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

async function assertInviteRegistrationAvailable(): Promise<void> {
  const settings = await getSetting('auth');
  if (!settings.localAuthEnabled) {
    throw forbidden('Email and password registration is disabled');
  }
  if (settings.registrationMode === 'closed') {
    throw forbidden('Account registration is closed');
  }
}

function assertUsableInvite(invite: {
  redeemedAt: Date | null;
  expiresAt: Date | null;
  role: string;
}): asserts invite is typeof invite & { role: UserRole } {
  if (invite.redeemedAt || (invite.expiresAt && invite.expiresAt.getTime() <= Date.now())) {
    throw validationFailed(INVALID_INVITE_MESSAGE);
  }
  if (!validRole(invite.role)) {
    logger.error('Invitation contains an invalid role');
    throw validationFailed(INVALID_INVITE_MESSAGE);
  }
}

/**
 * Whether a link can be used, and the address it is for, if it is for one: the
 * page fills it in, since no other address is accepted (#214). The link
 * holder learns nothing new: the invitation was sent to that address, and a
 * different one is refused with that reason anyway.
 */
export async function validateInvitation(
  token: string,
): Promise<{ emailLocked: boolean; email: string | null }> {
  await assertInviteRegistrationAvailable();
  const [invite] = await db
    .select({
      email: schema.invitation.email,
      role: schema.invitation.role,
      expiresAt: schema.invitation.expiresAt,
      redeemedAt: schema.invitation.redeemedAt,
    })
    .from(schema.invitation)
    .where(eq(schema.invitation.tokenHash, hashToken(token)))
    .limit(1);

  if (!invite) throw validationFailed(INVALID_INVITE_MESSAGE);
  assertUsableInvite(invite);
  return { emailLocked: Boolean(invite.email), email: invite.email?.trim().toLowerCase() || null };
}

interface RedeemedInvite {
  inviteId: string;
  userId: string;
  email: string;
  /** The invitation was emailed to this address, which proves it (#214). */
  verifiedByInvitation: boolean;
}

/**
 * Redeem under a row lock so two requests cannot consume the same token. The
 * raw token is reduced to its hash before it reaches a query and is never
 * persisted, returned, audited, or logged.
 */
export async function acceptInvitation(input: AcceptInviteInput): Promise<{
  emailVerificationRequired: boolean;
}> {
  await assertInviteRegistrationAvailable();
  const tokenHash = hashToken(input.token);
  const verificationPolicy = await isEmailVerificationEnforced();
  let createdUserId: string | null = null;

  let redeemed: RedeemedInvite;
  try {
    redeemed = await db.transaction(async (tx) => {
      const [invite] = await tx
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          role: schema.invitation.role,
          expiresAt: schema.invitation.expiresAt,
          redeemedAt: schema.invitation.redeemedAt,
          emailedAt: schema.invitation.emailedAt,
        })
        .from(schema.invitation)
        .where(eq(schema.invitation.tokenHash, tokenHash))
        .limit(1)
        .for('update');

      if (!invite) throw validationFailed(INVALID_INVITE_MESSAGE);
      assertUsableInvite(invite);

      const email = input.email.trim().toLowerCase();
      // Whoever is here holds the link, so saying the address differs gives
      // nothing away; "invalid" made people abandon an invitation that works.
      if (invite.email && invite.email.trim().toLowerCase() !== email) {
        throw validationFailed(
          'This invitation was sent to a different email address. Use the address it was sent to.',
        );
      }

      const [existing] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .limit(1);
      if (existing) throw conflict('An account with that email already exists');

      const created = await auth.api.createUser({
        body: {
          email,
          password: input.password,
          name: input.name,
          role: invite.role,
        },
      });
      createdUserId = created.user.id;

      // The row remains locked, but time can cross the expiry boundary while
      // Better Auth hashes the password and creates the credential account.
      if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
        throw validationFailed(INVALID_INVITE_MESSAGE);
      }

      // An invitation the server emailed to this address, accepted for that
      // address (refused above for any other), shows the person reads that
      // mailbox. Link-only invitations and ones created before the record
      // (emailed_at NULL) prove nothing: the administrator saw those links (#214).
      const verifiedByInvitation = Boolean(invite.emailedAt && invite.email);

      if (!verificationPolicy || verifiedByInvitation) {
        await tx
          .update(schema.user)
          .set({ emailVerified: true })
          .where(eq(schema.user.id, created.user.id));
      }

      const [claimed] = await tx
        .update(schema.invitation)
        .set({ redeemedAt: new Date(), redeemedByUserId: created.user.id })
        .where(
          and(
            eq(schema.invitation.id, invite.id),
            eq(schema.invitation.tokenHash, tokenHash),
            isNull(schema.invitation.redeemedAt),
          ),
        )
        .returning({ id: schema.invitation.id });
      if (!claimed) throw validationFailed(INVALID_INVITE_MESSAGE);

      return { inviteId: invite.id, userId: created.user.id, email, verifiedByInvitation };
    });
  } catch (error) {
    // Better Auth owns user/account creation on its own connection. If the
    // surrounding invite transaction subsequently fails, remove only the user
    // this request just created so redemption remains all-or-nothing.
    if (createdUserId) {
      await db
        .delete(schema.user)
        .where(eq(schema.user.id, createdUserId))
        .catch((cleanupError) => {
          logger.error({ cleanupError, userId: createdUserId }, 'Failed to roll back invited user');
        });
    }
    throw error;
  }

  let emailVerificationRequired = verificationPolicy && !redeemed.verifiedByInvitation;
  if (emailVerificationRequired) {
    try {
      await auth.api.sendVerificationEmail({
        body: { email: redeemed.email, callbackURL: '/' },
      });
      const [user] = await db
        .select({ emailVerified: schema.user.emailVerified })
        .from(schema.user)
        .where(eq(schema.user.id, redeemed.userId))
        .limit(1);
      emailVerificationRequired = !user?.emailVerified;
    } catch (error) {
      // Redemption stays complete, but delivery failure is not ownership proof.
      // The account can request another verification email once delivery recovers.
      logger.error({ error, userId: redeemed.userId }, 'Invite verification email failed');
      emailVerificationRequired = true;
    }
  }

  await recordAudit({
    actorUserId: redeemed.userId,
    actorEmail: redeemed.email,
    action: 'invite.redeem',
    targetType: 'invite',
    targetId: redeemed.inviteId,
    metadata: {
      roleApplied: true,
      ...(redeemed.verifiedByInvitation ? { emailVerifiedByInvitation: true } : {}),
    },
  }).catch((error) => logger.error({ error, inviteId: redeemed.inviteId }, 'Audit write failed'));

  return { emailVerificationRequired };
}

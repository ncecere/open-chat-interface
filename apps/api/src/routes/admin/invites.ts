import { desc, eq, schema } from '@oci/db';
import { createInviteSchema, type Invite } from '@oci/shared';
import { Hono } from 'hono';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { generateToken, hashToken } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { sendInviteEmail } from '../../services/email.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { getSetting } from '../../services/settings.js';

export const inviteRoutes = new Hono<AppBindings>();

const env = loadEnv();

function inviteUrl(token: string): string {
  // Keep the bearer token in the URL fragment so it is not sent in HTTP
  // request targets, referrers, reverse-proxy logs, or server access logs.
  return `${env.APP_URL}/auth/accept-invite#token=${encodeURIComponent(token)}`;
}

inviteRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(schema.invitation)
    .orderBy(desc(schema.invitation.createdAt))
    .limit(200);

  const invites: Omit<Invite, 'token'>[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as Invite['role'],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
    redeemedByUserId: row.redeemedByUserId,
    createdAt: row.createdAt.toISOString(),
  }));

  return c.json({ invites });
});

inviteRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createInviteSchema);
  const organizationId = await getDefaultOrganizationId();

  const token = generateToken();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const [created] = await db
    .insert(schema.invitation)
    .values({
      organizationId,
      email: input.email ?? null,
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt,
      createdByUserId: actor.id,
    })
    .returning({ id: schema.invitation.id });

  const url = inviteUrl(token);
  let emailDelivered = false;

  if (input.email) {
    const branding = await getSetting('branding');
    const result = await sendInviteEmail({
      to: input.email,
      url,
      appName: branding.appName,
    });
    emailDelivered = result.delivered;
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'invite.create',
    targetType: 'invite',
    targetId: created?.id ?? null,
    metadata: { email: input.email ?? null, role: input.role },
  });

  // The raw token is returned exactly once so the admin can copy the link.
  return c.json({ id: created?.id, url, emailDelivered }, 201);
});

inviteRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  const [existing] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, id))
    .limit(1);

  if (!existing) throw notFound('Invitation not found');

  await db.delete(schema.invitation).where(eq(schema.invitation.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'invite.revoke',
    targetType: 'invite',
    targetId: id,
  });

  return c.json({ ok: true });
});

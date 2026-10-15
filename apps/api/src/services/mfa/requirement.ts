import { and, eq, schema, sql } from '@oci/db';
import {
  ERROR_CODES,
  MFA_DEFAULT_GRACE_DAYS,
  type MfaImpact,
  type MfaImpactRole,
  type MfaRequirement,
  type MfaRequirementInput,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { isSatisfiedSession, mfaDeadline } from '../../auth/mfa.js';
import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type { SessionMfaFacts } from '../../middleware/context.js';
import { getSetting, normalizeMfaRequirement } from '../settings.js';

/**
 * Saving the per-role requirement for two-step verification, with the
 * safeguards that keep the break-glass administrator from being locked out
 * (v0.14, #399; SPEC-mfa.md section 4), and the figures the settings page shows
 * about who would be limited.
 *
 * Turning it on never removes the way in: a limited person always reaches
 * enrolment and sign-out (middleware/mfa-gate.ts). On top of that, a
 * requirement that changes is refused (409 MFA_REQUIRED_FOR_ACTOR) unless the
 * administrator saving it has passed a second step in this session, and one
 * naming `admin` is refused unless an enrolled, unbanned, verified local
 * administrator exists: nobody may switch on what they cannot complete.
 */
export const ACTOR_NOT_SATISFIED_MESSAGE =
  'To require two-step verification you must have used it yourself in this session. Set it up under Settings → Account, sign in with it, and save again.';
export const NO_ENROLLED_ADMIN_MESSAGE =
  'Administrators cannot be required to use two-step verification until at least one local administrator has set it up. Set it up under Settings → Account first.';

function refused(message: string, reason: 'actor_not_satisfied' | 'no_enrolled_admin') {
  return new AppError(ERROR_CODES.MFA_REQUIRED_FOR_ACTOR, message, 409, { reason });
}

const sameRoles = (a: readonly UserRole[], b: readonly UserRole[]) =>
  a.length === b.length && a.every((role) => b.includes(role));

export function requirementChanged(current: MfaRequirement, input: MfaRequirementInput): boolean {
  return !sameRoles(current.roles, input.roles) || current.graceDays !== input.graceDays;
}

/**
 * What an administrator's input makes of the stored requirement: the roles in
 * their order of `USER_ROLES`, a role newly added stamped now (a role kept keeps
 * its stamp, so editing the grace does not restart anyone's clock), a role removed
 * forgotten.
 */
export function nextRequirement(
  current: MfaRequirement,
  input: MfaRequirementInput,
  now: Date,
): MfaRequirement {
  const roles = USER_ROLES.filter((role) => input.roles.includes(role));
  const since: MfaRequirement['since'] = {};
  for (const role of roles) {
    const kept = current.roles.includes(role) ? current.since[role] : undefined;
    since[role] = kept && !Number.isNaN(Date.parse(kept)) ? kept : now.toISOString();
  }
  return { roles, graceDays: input.graceDays, since };
}

/** Local administrators who could complete the requirement: unbanned, verified, a password, and a second step set up. */
export async function enrolledLocalAdministrators(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.user)
    .where(
      and(
        eq(schema.user.role, 'admin'),
        eq(schema.user.banned, false),
        eq(schema.user.emailVerified, true),
        sql`exists (select 1 from ${schema.account} where ${schema.account.userId} = ${schema.user.id} and ${schema.account.providerId} = 'credential')`,
        sql`(${schema.user.twoFactorEnabled} or exists (select 1 from ${schema.passkey} where ${schema.passkey.userId} = ${schema.user.id}))`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Throws 409 MFA_REQUIRED_FOR_ACTOR when the new requirement is one the acting
 * administrator (by their session) could not complete, or one naming `admin`
 * that no administrator could. Removing a requirement is always allowed.
 */
export async function assertRequirementAllowed(
  next: MfaRequirement,
  actorFacts: SessionMfaFacts | null | undefined,
): Promise<void> {
  if (next.roles.length === 0) return;
  if (!isSatisfiedSession(actorFacts?.authMethod, actorFacts?.twoFactorEnabled ?? false)) {
    throw refused(ACTOR_NOT_SATISFIED_MESSAGE, 'actor_not_satisfied');
  }
  if (next.roles.includes('admin') && (await enrolledLocalAdministrators()) === 0) {
    throw refused(NO_ENROLLED_ADMIN_MESSAGE, 'no_enrolled_admin');
  }
}

/** The stored requirement, normalised. */
export async function currentRequirement(): Promise<MfaRequirement> {
  return normalizeMfaRequirement((await getSetting('auth')).mfaRequirement);
}

interface RoleCounts {
  role: string;
  people: number;
  exempt: number;
  enrolled: number;
  unenrolled: number;
}

const HAS_CREDENTIAL = sql`exists (select 1 from ${schema.account} where ${schema.account.userId} = ${schema.user.id} and ${schema.account.providerId} = 'credential')`;
const HAS_SECOND_STEP = sql`(${schema.user.twoFactorEnabled} or exists (select 1 from ${schema.passkey} where ${schema.passkey.userId} = ${schema.user.id}))`;

/**
 * Who the requirement would limit, per role, for the saved requirement:
 * unbanned accounts, those with no password (never limited), those with a
 * second step, and those without one, with the earliest deadline and how many
 * are limited already.
 */
export async function mfaImpact(
  requirement?: MfaRequirement,
  now = new Date(),
): Promise<MfaImpact> {
  const saved = requirement ?? (await currentRequirement());
  const counts = (await db.execute(sql`
    select ${schema.user.role} as role,
      count(*)::int as people,
      count(*) filter (where not ${HAS_CREDENTIAL})::int as exempt,
      count(*) filter (where ${HAS_CREDENTIAL} and ${HAS_SECOND_STEP})::int as enrolled,
      count(*) filter (where ${HAS_CREDENTIAL} and not ${HAS_SECOND_STEP})::int as unenrolled
    from ${schema.user}
    where not ${schema.user.banned}
    group by ${schema.user.role}`)) as unknown as RoleCounts[];

  const roles: MfaImpactRole[] = [];
  for (const role of USER_ROLES) {
    const found = counts.find((row) => row.role === role);
    const required = saved.roles.includes(role);
    let firstDeadline: string | null = null;
    let limitedNow = 0;
    if (required && (found?.unenrolled ?? 0) > 0) {
      // A person's deadline is max(stamp, created) + grace, so the earliest
      // deadline belongs to the oldest unenrolled account, and a person is
      // limited now when the stamp's and their own account's deadlines have both passed.
      const [row] = (await db.execute(sql`
        select min(${schema.user.createdAt}) as earliest,
          count(*) filter (where ${schema.user.createdAt} + make_interval(days => ${saved.graceDays}) <= ${now.toISOString()}::timestamptz)::int as aged
        from ${schema.user}
        where not ${schema.user.banned} and ${schema.user.role} = ${role}
          and ${HAS_CREDENTIAL} and not ${HAS_SECOND_STEP}`)) as unknown as Array<{
        earliest: Date | string | null;
        aged: number;
      }>;
      const earliest = row?.earliest ? new Date(row.earliest) : null;
      firstDeadline = earliest ? (mfaDeadline(saved, role, earliest)?.toISOString() ?? null) : null;
      const stamp = Date.parse(saved.since[role] ?? '');
      const stampDeadline = Number.isNaN(stamp) ? 0 : stamp + saved.graceDays * 24 * 60 * 60 * 1000;
      limitedNow = stampDeadline <= now.getTime() ? (row?.aged ?? 0) : 0;
    }
    roles.push({
      role,
      people: found?.people ?? 0,
      exempt: found?.exempt ?? 0,
      enrolled: found?.enrolled ?? 0,
      unenrolled: found?.unenrolled ?? 0,
      required,
      since: required ? (saved.since[role] ?? null) : null,
      firstDeadline,
      limitedNow,
    });
  }
  return { graceDays: saved.graceDays ?? MFA_DEFAULT_GRACE_DAYS, roles };
}

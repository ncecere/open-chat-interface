import { and, desc, eq, isNull, schema, sql } from '@oci/db';
import type { LegalHold, LiftLegalHoldInput, PlaceLegalHoldInput } from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';

export {
  HELD_ACCOUNT_DELETION_MESSAGE,
  HELD_MEMORY_DELETION_MESSAGE,
  HELD_PERMANENT_DELETION_MESSAGE,
  HELD_PROJECT_DELETION_MESSAGE,
  HELD_SELF_DELETION_MESSAGE,
  isLegalHoldViolation,
} from './hold-errors.js';

/**
 * Legal holds: named people whose data must be preserved. While a hold is
 * active, retention, trash purging, temporary chat expiry, memory retention,
 * usage-event and share-link pruning skip that person's data; their own
 * permanent deletions (delete forever, empty trash, deleting a project or a
 * project file, deleting memories) and account deletion are refused. Moving a
 * conversation or a file to the trash still works. A database trigger
 * (migration 0034) refuses to delete a held account on any code path,
 * including Better Auth's own admin endpoints. Every deletion path and how it
 * treats a hold is listed in `__tests__/unit/legal-hold-paths.unit.test.ts`.
 *
 * A hold takes effect for work that starts after it is placed: a purge that
 * is already deleting when the hold commits is not rolled back.
 */

type Actor = { id: string; email: string };

/**
 * A condition that is true when the person in `userColumn` is not on hold.
 * Used by every bulk deletion that must skip held people's data.
 */
export function notOnLegalHold(userColumn: unknown): ReturnType<typeof sql> {
  return sql`not exists (select 1 from ${schema.legalHold}
    where ${schema.legalHold.userId} = ${userColumn}
      and ${schema.legalHold.liftedAt} is null)`;
}

export async function isOnLegalHold(
  userId: string,
  /** A transaction, to check under the locks it already holds. */
  executor: Pick<typeof db, 'select'> = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: schema.legalHold.id })
    .from(schema.legalHold)
    .where(and(eq(schema.legalHold.userId, userId), isNull(schema.legalHold.liftedAt)))
    .limit(1);
  return Boolean(row);
}

type HoldRow = typeof schema.legalHold.$inferSelect;

function toView(row: HoldRow, user?: { email: string; name: string } | null): LegalHold {
  return {
    id: row.id,
    userId: row.userId,
    userEmail: user?.email ?? row.userEmail,
    userName: user?.name ?? null,
    reason: row.reason,
    placedAt: row.placedAt.toISOString(),
    placedByEmail: row.placedByEmail,
    liftedAt: row.liftedAt?.toISOString() ?? null,
    liftedByEmail: row.liftedByEmail,
    liftReason: row.liftReason,
  };
}

/** Active holds first (newest first), then, if asked, the most recent lifted ones. */
export async function listLegalHolds(options: { includeLifted?: boolean; limit?: number } = {}) {
  const rows = await db
    .select({ hold: schema.legalHold, email: schema.user.email, name: schema.user.name })
    .from(schema.legalHold)
    .leftJoin(schema.user, eq(schema.user.id, schema.legalHold.userId))
    .where(options.includeLifted ? undefined : isNull(schema.legalHold.liftedAt))
    .orderBy(sql`${schema.legalHold.liftedAt} is not null`, desc(schema.legalHold.placedAt))
    .limit(Math.max(1, Math.min(options.limit ?? 200, 500)));
  return rows.map((row) =>
    toView(row.hold, row.email ? { email: row.email, name: row.name ?? '' } : null),
  );
}

/** The active hold on one person, for their account page. */
export async function activeLegalHold(userId: string): Promise<LegalHold | null> {
  const [row] = await db
    .select()
    .from(schema.legalHold)
    .where(and(eq(schema.legalHold.userId, userId), isNull(schema.legalHold.liftedAt)))
    .limit(1);
  return row ? toView(row) : null;
}

/** Places a hold on one person, named by id or email. Audited as `compliance.hold.place`. */
export async function placeLegalHold(
  actor: Actor,
  input: PlaceLegalHoldInput,
  ipAddress: string | null,
): Promise<LegalHold> {
  const [target] = await db
    .select({ id: schema.user.id, email: schema.user.email, name: schema.user.name })
    .from(schema.user)
    .where(
      input.userId
        ? eq(schema.user.id, input.userId)
        : sql`lower(${schema.user.email}) = ${input.email ?? ''}`,
    )
    .limit(1);
  if (!target) throw notFound('No account has that address.');

  // The partial unique index is the real guard against two concurrent holds.
  const [row] = await db
    .insert(schema.legalHold)
    .values({
      organizationId: await getDefaultOrganizationId(),
      userId: target.id,
      userEmail: target.email,
      reason: input.reason,
      placedByUserId: actor.id,
      placedByEmail: actor.email,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`${target.email} is already on legal hold.`);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'compliance.hold.place',
    targetType: 'user',
    targetId: target.id,
    ipAddress,
    metadata: { holdId: row.id, email: target.email, reason: input.reason },
  });
  return toView(row, target);
}

/** Lifts an active hold. Audited as `compliance.hold.lift`. */
export async function liftLegalHold(
  actor: Actor,
  holdId: string,
  input: LiftLegalHoldInput,
  ipAddress: string | null,
): Promise<LegalHold> {
  const [row] = await db
    .update(schema.legalHold)
    .set({
      liftedAt: new Date(),
      liftedByUserId: actor.id,
      liftedByEmail: actor.email,
      liftReason: input.reason || null,
    })
    .where(and(eq(schema.legalHold.id, holdId), isNull(schema.legalHold.liftedAt)))
    .returning();
  if (!row) throw notFound('No active hold has that id.');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'compliance.hold.lift',
    targetType: 'user',
    targetId: row.userId,
    ipAddress,
    metadata: { holdId: row.id, email: row.userEmail, reason: input.reason || null },
  });
  return toView(row);
}

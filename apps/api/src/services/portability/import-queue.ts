import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';

export type ImportRow = typeof schema.conversationImport.$inferSelect;

/** A running import that has not reported progress for this long is presumed dead. */
const IMPORT_STALE_MS = 10 * 60 * 1000;

/**
 * Claims the oldest runnable import.
 *
 * `skip locked` lets replicas claim concurrently; a running row whose heartbeat
 * has gone stale was abandoned by a crash or restart and is claimed again,
 * which is safe because applying an import is idempotent. A person's second
 * import never starts while their first is genuinely running.
 */
export async function claimNextImport(now = new Date()): Promise<ImportRow | null> {
  const staleBefore = new Date(now.getTime() - IMPORT_STALE_MS).toISOString();
  const [row] = await db
    .update(schema.conversationImport)
    .set({
      status: 'running',
      attempts: sql`${schema.conversationImport.attempts} + 1`,
      startedAt: sql`coalesce(${schema.conversationImport.startedAt}, now())`,
      updatedAt: now,
    })
    .where(
      eq(
        schema.conversationImport.id,
        sql`(
          select candidate.id from conversation_import candidate
          where (
            candidate.status = 'pending'
            or (candidate.status = 'running' and candidate.updated_at < ${staleBefore}::timestamptz)
          )
          and not exists (
            select 1 from conversation_import other
            where other.user_id = candidate.user_id
              and other.id <> candidate.id
              and other.status = 'running'
              and other.updated_at >= ${staleBefore}::timestamptz
          )
          order by candidate.created_at, candidate.id
          limit 1
          for update skip locked
        )`,
      ),
    )
    .returning();
  return row ?? null;
}

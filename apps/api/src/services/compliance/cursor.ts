import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';

/**
 * The compliance export's position in each stream: every row with a sequence
 * number at or below it has been written and verified. Kept small so
 * retention can consult it without loading the exporter.
 */

type ComplianceStream = 'audit' | 'messages';

/** The stream's cursor, or null when the stream has never been started. */
export async function exportCursor(stream: ComplianceStream): Promise<number | null> {
  const [row] = await db
    .select({ lastSeq: schema.complianceExportCursor.lastSeq })
    .from(schema.complianceExportCursor)
    .where(eq(schema.complianceExportCursor.stream, stream))
    .limit(1);
  return row ? Number(row.lastSeq) : null;
}

/**
 * The highest sequence number below which every row is committed, read
 * under a brief SHARE lock.
 *
 * A sequence alone is not enough: a transaction can draw number 10, a second
 * draw 11 and commit, and an export reading then would pass 10 before it
 * becomes visible. SHARE conflicts with the ROW EXCLUSIVE lock every insert
 * and update takes before it draws a number, so acquiring it waits for all
 * transactions already writing and briefly holds back new ones; the maximum
 * read under it is final. The lock is held for one index lookup. A writer
 * holding the table longer than `lockTimeoutMs` makes the attempt fail
 * rather than queue the application's writes behind it; the export then
 * retries, and finally fails without moving the cursor.
 */
export async function committedWatermark(
  stream: ComplianceStream,
  options: { lockTimeoutMs?: number; attempts?: number } = {},
): Promise<number> {
  const table = stream === 'audit' ? 'audit_log' : 'message';
  const column = stream === 'audit' ? 'seq' : 'change_seq';
  const timeout = Math.max(10, Math.min(Math.round(options.lockTimeoutMs ?? 2_000), 60_000));
  const attempts = Math.max(1, options.attempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          // Neither value is user input: the table and column are fixed above.
          await tx.execute(sql.raw(`set local lock_timeout = '${timeout}ms'`));
          await tx.execute(sql.raw(`lock table "${table}" in share mode`));
          const [row] = await tx.execute<{ max: string | number | null }>(
            sql.raw(`select max("${column}") as max from "${table}"`),
          );
          return Number(row?.max ?? 0);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (!isLockTimeout(error) || attempt >= attempts) {
        if (isLockTimeout(error))
          throw new Error(
            `The ${stream === 'audit' ? 'audit log' : 'message table'} stayed busy; the export will try again on its next run.`,
          );
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

function isLockTimeout(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 5; depth++) {
    if ('code' in cause && cause.code === '55P03') return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * Moves a cursor from `after` to `through`, only if it is still at `after`
 * (or, for `after` 0, does not exist yet). Returns false when another run
 * moved it first; the caller must then discard what it wrote.
 */
export async function advanceCursor(
  executor: Pick<typeof db, 'execute'>,
  stream: ComplianceStream,
  after: number,
  through: number,
  runId: string,
): Promise<boolean> {
  const rows = await executor.execute<{ stream: string }>(sql`
    insert into ${schema.complianceExportCursor} (stream, last_seq, last_run_id, updated_at)
    values (${stream}, ${through}, ${runId}, now())
    on conflict (stream) do update
      set last_seq = excluded.last_seq, last_run_id = excluded.last_run_id, updated_at = now()
      where ${schema.complianceExportCursor.lastSeq} = ${after}
    returning stream
  `);
  if (rows.length > 0) return true;
  return false;
}

/** Starts (or restarts) a stream from now: used when content export is turned on. */
export async function resetCursorToNow(stream: ComplianceStream): Promise<number> {
  const through = await committedWatermark(stream);
  await db.execute(sql`
    insert into ${schema.complianceExportCursor} (stream, last_seq, last_run_id, updated_at)
    values (${stream}, ${through}, null, now())
    on conflict (stream) do update
      set last_seq = excluded.last_seq, last_run_id = null, updated_at = now()
  `);
  return through;
}

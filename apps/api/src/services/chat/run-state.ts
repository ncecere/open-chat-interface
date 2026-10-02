import { and, eq, isNull, or, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';

export type OwnedRunState = 'streaming' | 'terminal' | 'missing';

/**
 * The assistant message a run writes. A first run's ID is the message ID; a
 * reply continued after an approval runs as `<message id>:<suffix>`.
 */
export function runMessageId(runId: string): string {
  return runId.split(':', 1)[0]!;
}

/**
 * Read only the exact assistant's durable status, never its payload. Unlike
 * getOwnedThread, this does not expire/delete a thread as a side effect.
 */
export async function readOwnedRunState(
  identity: { runId: string; threadId: string; userId: string },
  signal?: AbortSignal,
): Promise<OwnedRunState> {
  signal?.throwIfAborted();
  return db.transaction(
    async (tx) => {
      // A reader may have timed out while waiting for a pool slot. Do not start a
      // status lookup then. The local SQL deadline also bounds table-lock waits;
      // it is restored when this short read-only transaction ends.
      signal?.throwIfAborted();
      await tx.execute(sql`set local statement_timeout = '1000ms'`);
      signal?.throwIfAborted();
      const [row] = await tx
        .select({ status: schema.message.status })
        .from(schema.message)
        .innerJoin(schema.thread, eq(schema.thread.id, schema.message.threadId))
        .where(
          and(
            eq(schema.message.id, runMessageId(identity.runId)),
            eq(schema.message.threadId, identity.threadId),
            eq(schema.message.userId, identity.userId),
            eq(schema.message.role, 'assistant'),
            eq(schema.thread.userId, identity.userId),
            isNull(schema.thread.deletedAt),
            or(
              eq(schema.thread.temporary, false),
              sql`${schema.thread.expiresAt} > clock_timestamp()`,
            ),
          ),
        )
        .limit(1);
      signal?.throwIfAborted();
      if (!row) return 'missing';
      if (row.status === 'streaming') return 'streaming';
      return ['complete', 'error', 'cancelled'].includes(row.status) ? 'terminal' : 'missing';
    },
    { accessMode: 'read only' },
  );
}

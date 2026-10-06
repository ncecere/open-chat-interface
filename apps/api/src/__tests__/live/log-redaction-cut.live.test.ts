import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { outageProxy } from '../../../test/failover.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import { logger } from '../../lib/logger.js';

/**
 * #264, a connection cut while the reply is being saved: a real PostgreSQL
 * behind a proxy that is cut mid-query, as a failover does. Drizzle's error
 * carries the reply text in its message and params; the application logger
 * writes none of it, whichever way the error is logged. (A query whose
 * connection never opens is covered without a database by
 * log-redaction.integration.test.ts.)
 */
const available = await livePostgresAvailable();
const REPLY_CANARY = 'OTTER-CANARY-2641 the reply text';

describe.skipIf(!available)('live: log redaction of a query cut mid-flight', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('log_redaction_cut');
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('logs the cut save without the reply text', async () => {
    const proxy = await outageProxy(live.connectionString);
    const pool = createDatabase(proxy.url, { max: 1 });
    try {
      // The final save's update, held open by the server so the cut lands
      // while the query is in flight.
      const saving = pool.db
        .update(schema.message)
        .set({ parts: [{ type: 'text', text: REPLY_CANARY }] })
        .where(sql`${eq(schema.message.id, randomUUID())} and exists (select 1 from pg_sleep(5))`);
      const settled = saving.then(
        () => null,
        (error: unknown) => error as Error & { params?: unknown },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await proxy.cut();
      const error = await settled;

      // The precondition: Drizzle's error does carry the reply text.
      expect(error).not.toBeNull();
      expect(error!.message).toContain(REPLY_CANARY);
      expect(error!.params).toBeDefined();

      const lines: string[] = [];
      const stream = (logger as unknown as Record<symbol, { write(line: string): unknown }>)[
        pino.symbols.streamSym
      ]!;
      const spy = vi.spyOn(stream, 'write').mockImplementation((line: string) => {
        lines.push(line);
        return true;
      });
      try {
        logger.warn(
          { err: error!.message },
          'Database connection lost while saving a reply; retrying',
        );
        logger.error({ error }, 'Failed to persist assistant message');
        logger.error({ err: new Error('Saving failed', { cause: error }) }, 'wrapped');
      } finally {
        spy.mockRestore();
      }

      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).not.toContain('OTTER-CANARY');
      const persisted = JSON.parse(lines[1]!);
      expect(persisted.error.type).toBe('DrizzleQueryError');
      expect(persisted.error.params).toBe('[redacted]');
      expect(persisted.error.query).toContain('update "message"');
    } finally {
      await proxy.close();
      await pool.sql.end({ timeout: 1 });
    }
  });
});

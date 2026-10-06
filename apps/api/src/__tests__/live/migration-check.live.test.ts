import { connect, createServer, type Server } from 'node:net';
import { createDatabase, migrationsApplied } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
} from '../../../test/live-postgres.js';
import { requireMigrationsRecorded } from '../../db/migration-check.js';

/**
 * Starting with RUN_MIGRATIONS=false while PostgreSQL is down (#137). The
 * migration check read every error as "not recorded", so a worker restarting
 * during a database outage failed six times telling the operator to run
 * `pnpm db:migrate`.
 */
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const available = await livePostgresAvailable();

/** A loopback port with nothing listening on it (connections are refused). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** `connectionString` with its host and port replaced. */
function via(connectionString: string, port: number): string {
  const url = new URL(connectionString);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

describe.skipIf(!available)('live migration check with the database down', () => {
  let live: LiveDatabase;
  beforeAll(async () => {
    live = await createLiveDatabase('migration_check');
  });
  afterAll(async () => {
    await live?.destroy();
  });

  it('does not answer "not recorded" when the database cannot be reached', async () => {
    const down = createDatabase(via(live.connectionString, await freePort()), { max: 1 });
    try {
      await expect(migrationsApplied(down.db)).rejects.toMatchObject({
        cause: expect.objectContaining({ code: 'ECONNREFUSED' }),
      });
    } finally {
      await down.sql.end({ timeout: 1 });
    }
  });

  it('says the database is unreachable once its wait runs out', async () => {
    const down = createDatabase(via(live.connectionString, await freePort()), { max: 1 });
    try {
      const failure = requireMigrationsRecorded(down.db, { budgetMs: 300, initialDelayMs: 50 });
      await expect(failure).rejects.toThrow(/Could not reach the database/);
      await expect(failure).rejects.not.toThrow(/migration is not recorded/);
    } finally {
      await down.sql.end({ timeout: 1 });
    }
  });

  // A database host that does not resolve (a stopped Compose service, a
  // rescheduled pod, a DNS failover) is unreachable too: the worker in #230
  // crash-looped on the raw "Failed query: select exists ..." instead of
  // waiting. `.invalid` never resolves (RFC 2606).
  it('waits for a database host that does not resolve, then says it is unreachable', async () => {
    const { logger } = await import('../../lib/logger.js');
    vi.mocked(logger.warn).mockClear();
    const url = new URL(live.connectionString);
    url.hostname = 'oci-fix3-database.invalid';
    const unresolved = createDatabase(url.toString(), { max: 1 });
    try {
      const started = Date.now();
      const failure = requireMigrationsRecorded(unresolved.db, {
        budgetMs: 600,
        initialDelayMs: 50,
      });
      await expect(failure).rejects.toThrow(
        /^Could not reach the database to check its migrations \(getaddrinfo (ENOTFOUND|EAI_AGAIN) oci-fix3-database\.invalid\)/,
      );
      await expect(failure).rejects.not.toThrow(/Failed query/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      // A clear line while it waits: the resolver's error, not the query.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringMatching(/^getaddrinfo /) }),
        'The database is unreachable; waiting for it before checking its migrations',
      );
    } finally {
      await unresolved.sql.end({ timeout: 1 });
    }
  });

  it('waits for a database that comes back, then starts', async () => {
    const port = await freePort();
    const target = new URL(live.connectionString);
    const back = createDatabase(via(live.connectionString, port), { max: 1 });
    let proxy: Server | undefined;
    // PostgreSQL "starts again" 600 ms in.
    const starting = setTimeout(() => {
      proxy = createServer((client) => {
        const upstream = connect(Number(target.port || 5432), target.hostname);
        client.pipe(upstream).pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      }).listen(port, '127.0.0.1');
    }, 600);
    try {
      await expect(
        requireMigrationsRecorded(back.db, { budgetMs: 10_000, initialDelayMs: 100 }),
      ).resolves.toBeUndefined();
    } finally {
      clearTimeout(starting);
      await back.sql.end({ timeout: 1 });
      await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve(undefined)));
    }
  });

  it('still reports a database whose migrations are missing', async () => {
    const { sql } = await import('@oci/db');
    await live.db.execute(sql`drop schema drizzle cascade`);
    await expect(requireMigrationsRecorded(live.db)).rejects.toThrow(
      /latest required database migration is not recorded/,
    );
  });
});

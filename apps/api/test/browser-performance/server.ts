import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveDatabase } from '../live-postgres.js';
import {
  CHUNK_DELAY_MS,
  createFixtureProvider,
  FIXTURE_MODEL,
  INITIAL_DELAY_MS,
  RESPONSE_MARKDOWN,
  STREAM_CHUNKS,
} from './provider.js';

const URLS = {
  baseline: 'http://127.0.0.1:4179',
  candidate: 'http://127.0.0.1:4178',
  api: 'http://127.0.0.1:4180',
  provider: 'http://127.0.0.1:4181/v1',
  providerStats: 'http://127.0.0.1:4181/stats',
};

/** Reject URL options too: postgres.js accepts query parameters overriding the host. */
export function validateDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('Explicit TEST_DATABASE_URL is required; DATABASE_URL is ignored.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid local PostgreSQL URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    url.pathname.length < 2
  ) {
    throw new Error(
      'TEST_DATABASE_URL requires a loopback host, database name, and no URL options.',
    );
  }
  return url.toString();
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    // Abort outstanding SSE/keep-alive sockets instead of hanging on shutdown.
    server.closeAllConnections();
  });
}

export async function main(): Promise<void> {
  if (process.env.OCI_BROWSER_FIXTURE !== '1') {
    throw new Error('Set OCI_BROWSER_FIXTURE=1 to opt in to the disposable browser fixture.');
  }
  const adminUrl = validateDatabaseUrl(process.env.TEST_DATABASE_URL);
  // The shared helper's fallback to DATABASE_URL is never reachable here.
  process.env.TEST_DATABASE_URL = adminUrl;
  delete process.env.DATABASE_URL;

  let directory: string | undefined;
  let fixture: LiveDatabase | undefined;
  let apiSql: { end: (options: { timeout: number }) => Promise<void> } | undefined;
  let provider: Server | undefined;
  let api: Server | undefined;
  let stopping = false;
  let starting = true;
  let cleanupPromise: Promise<void> | undefined;
  let stage = 'temporary directory setup';
  const checkStopping = () => {
    if (stopping) throw new Error('Fixture startup interrupted');
  };
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      let failed = false;
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch {
          failed = true;
        }
      };
      await attempt(() => closeServer(api));
      await attempt(() => closeServer(provider));
      if (apiSql) await attempt(() => apiSql!.end({ timeout: 5 }));
      // destroy() targets the helper's exact random database, never a prefix scan.
      if (fixture) await attempt(() => fixture!.destroy());
      if (directory) await attempt(() => rm(directory!, { recursive: true, force: true }));
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (failed) {
        process.exitCode = 1;
        console.error(
          'Browser fixture cleanup was incomplete; inspect the disposable PostgreSQL server.',
        );
      }
    })();
    return cleanupPromise;
  };
  const stop = () => {
    stopping = true;
    // Do not race a pending create/migrate/seed with a database drop.
    if (!starting) void cleanup();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    directory = await mkdtemp(join(tmpdir(), 'oci-browser-performance-'));
    await chmod(directory, 0o700);
    const storage = join(directory, 'storage');
    await mkdir(storage, { mode: 0o700 });
    const password = randomBytes(24).toString('base64url');
    const { ADMIN_EMAIL, seedBrowserData } = await import('./seed.js');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_URL: URLS.candidate,
      AUTH_TRUSTED_ORIGINS: `${URLS.baseline},${URLS.candidate}`,
      API_PORT: '4180',
      AUTH_SECRET: randomBytes(32).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      INITIAL_ADMIN_EMAIL: ADMIN_EMAIL,
      INITIAL_ADMIN_PASSWORD: password,
      STORAGE_LOCAL_PATH: storage,
      RUN_MIGRATIONS: 'false',
      LOG_LEVEL: 'fatal',
    });
    delete process.env.REDIS_URL;
    // Keep policy defaults independent of a developer's shell configuration.
    for (const key of Object.keys(process.env)) {
      if (/^(RETENTION_|RATE_LIMIT_|QUOTA_RESERVE_)/.test(key)) delete process.env[key];
    }
    // The browser suites sign the same account in from one address, in
    // parallel, far more often than the authentication limit (10 a minute per
    // address and per account since v0.10) allows a person to.
    process.env.RATE_LIMIT_AUTH_PER_MINUTE = '100000';
    delete process.env.DISPLAY_TIMEZONE;
    checkStopping();

    stage = 'database creation/migration';
    const { createLiveDatabase } = await import('../live-postgres.js');
    fixture = await createLiveDatabase('browser_perf');
    process.env.DATABASE_URL = fixture.connectionString;
    checkStopping();

    stage = 'database/admin seeding';
    const { seedDatabase } = await import('@oci/db');
    await seedDatabase(fixture.db);
    // No production module that reads loadEnv is imported before this point.
    const database = await import('../../src/db/index.js');
    apiSql = database.sql;
    const { ensureInitialAdmin } = await import('../../src/bootstrap.js');
    await ensureInitialAdmin();
    checkStopping();
    const { encryptSecret } = await import('../../src/lib/crypto.js');
    const scenarios = await seedBrowserData(
      fixture.db,
      encryptSecret('local-fixture-not-a-real-key'),
    );
    checkStopping();

    stage = 'provider binding';
    provider = createFixtureProvider();
    provider.listen(4181, '127.0.0.1');
    await once(provider, 'listening');
    checkStopping();

    stage = 'API binding';
    const { createApp } = await import('../../src/app.js');
    const { serve } = await import('@hono/node-server');
    // Deliberately bypass src/server.ts: no lifecycle jobs, Redis, or extra migrations.
    api = serve({ fetch: createApp().fetch, hostname: '127.0.0.1', port: 4180 }) as Server;
    await once(api, 'listening');
    checkStopping();

    stage = 'metadata publication';
    const metadataPath = join(directory, 'metadata.json');
    await writeFile(
      join(directory, 'credentials.json'),
      `${JSON.stringify({ email: ADMIN_EMAIL, password }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          version: 1,
          urls: URLS,
          model: FIXTURE_MODEL,
          databaseName: new URL(fixture.connectionString).pathname.slice(1),
          redis: false,
          stream: {
            chunks: STREAM_CHUNKS,
            initialDelayMs: INITIAL_DELAY_MS,
            chunkDelayMs: CHUNK_DELAY_MS,
            responseBytes: Buffer.byteLength(RESPONSE_MARKDOWN),
            syntheticUsage: true,
          },
          scenarios,
        },
        null,
        2,
      )}\n`,
      { mode: 0o644, flag: 'wx' },
    );
    checkStopping();
    starting = false;
    console.log(`Browser performance fixture ready: ${metadataPath}`);
  } catch {
    starting = false;
    if (!stopping) {
      process.exitCode = 1;
      // Do not serialize errors: database URLs and credentials can appear in them.
      console.error(`Browser performance fixture failed during ${stage}.`);
    }
    await cleanup();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    // Only preflight validation errors reach here, and their messages contain no input values.
    console.error(error instanceof Error ? error.message : 'Browser fixture preflight failed.');
    process.exitCode = 1;
  });
}

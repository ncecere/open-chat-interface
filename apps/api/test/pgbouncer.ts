import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const run = promisify(execFile);

/**
 * A real PgBouncer in transaction mode in front of the live tests' PostgreSQL
 * (v0.11 design, section 11), started in Docker for one test file.
 *
 * Image: edoburu/pgbouncer (MIT; PgBouncer itself is ISC), pinned by digest.
 * A small pool (`default_pool_size = 2`) makes server connections change
 * hands between clients all the time, so anything that relies on session
 * state shows at once.
 *
 * Networking: on Linux (CI) the container shares the host network and
 * reaches PostgreSQL where the tests do; elsewhere (Docker Desktop) it
 * publishes a port and reaches the host through `host.docker.internal`.
 */
export const PGBOUNCER_IMAGE =
  'edoburu/pgbouncer:v1.25.2-p0@sha256:7d7a27d9e90985cab5cf42256f5c13a3120baa4b055b69df37beb272b89b2340';

export interface PgBouncer {
  /** `connectionString` with its host and port replaced by PgBouncer's. */
  pooled(connectionString: string): string;
  stop(): Promise<void>;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });
}

export async function startPgBouncer(
  directUrl: string,
  options: { poolSize?: number } = {},
): Promise<PgBouncer> {
  const url = new URL(directUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const linux = process.platform === 'linux';
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  const serverHost = loopback && !linux ? 'host.docker.internal' : url.hostname;
  const listenPort = linux ? await freePort() : 6432;

  const dir = mkdtempSync(join(tmpdir(), 'oci-pgbouncer-'));
  chmodSync(dir, 0o755);
  const ini = join(dir, 'pgbouncer.ini');
  const users = join(dir, 'userlist.txt');
  writeFileSync(
    ini,
    [
      '[databases]',
      // Every database name, so each test's throwaway database works.
      `* = host=${serverHost} port=${url.port || '5432'}`,
      '[pgbouncer]',
      'listen_addr = 0.0.0.0',
      `listen_port = ${listenPort}`,
      'auth_type = scram-sha-256',
      'auth_file = /etc/pgbouncer/userlist.txt',
      'pool_mode = transaction',
      `default_pool_size = ${options.poolSize ?? 2}`,
      'max_client_conn = 500',
      'max_db_connections = 0',
      // What a production transaction-mode PgBouncer is given: no reset
      // between clients (transaction mode never runs one anyway).
      'server_reset_query =',
      'ignore_startup_parameters = extra_float_digits',
      `admin_users = ${user}`,
      'log_connections = 0',
      'log_disconnections = 0',
      '',
    ].join('\n'),
  );
  writeFileSync(users, `"${user}" "${password.replace(/"/g, '""')}"\n`);
  chmodSync(ini, 0o644);
  chmodSync(users, 0o644);

  const name = `oci-test-pgbouncer-${randomUUID().slice(0, 8)}`;
  const network = linux
    ? ['--network', 'host']
    : ['-p', `127.0.0.1::${listenPort}`, '--add-host', 'host.docker.internal:host-gateway'];
  await run(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      ...network,
      '-v',
      `${ini}:/etc/pgbouncer/pgbouncer.ini:ro`,
      '-v',
      `${users}:/etc/pgbouncer/userlist.txt:ro`,
      PGBOUNCER_IMAGE,
    ],
    { timeout: 120_000 },
  );

  let port = listenPort;
  if (!linux) {
    const { stdout } = await run('docker', ['port', name, `${listenPort}/tcp`]);
    port = Number(stdout.trim().split('\n')[0]!.split(':').at(-1));
  }
  const pooled = (connectionString: string) => {
    const target = new URL(connectionString);
    target.hostname = '127.0.0.1';
    target.port = String(port);
    return target.toString();
  };

  // Ready once a query passes through it.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probe = postgres(pooled(directUrl), { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await probe`select 1`;
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        await run('docker', ['rm', '-f', name]).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await probe.end({ timeout: 1 }).catch(() => undefined);
    }
  }

  return {
    pooled,
    stop: async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../config/env.js';

/**
 * Running PostgreSQL's client tools without exposing the database password.
 *
 * The connection is passed through libpq environment variables, never as
 * arguments (which any local user can read from the process list), and the
 * password through a `.pgpass` file in a private temporary directory, not
 * `PGPASSWORD` (which is visible in the child's environment). The child gets
 * only the variables it needs, not the API's own environment and secrets.
 * Error output is scrubbed of the password before anyone sees it.
 */

type PgTool = 'pg_dump' | 'pg_restore';

export function pgToolPath(tool: PgTool, binDir = loadEnv().BACKUP_PG_BIN_DIR): string {
  return binDir ? join(binDir, tool) : tool;
}

/** `.pgpass` escaping: backslash and colon are escaped with a backslash. */
const pgpassField = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

interface PgConnection {
  /** Variables for the child process; contains no password. */
  env: Record<string, string>;
  /** The password, only for scrubbing output. Null when the URL has none. */
  password: string | null;
  /** Removes the temporary password file. */
  cleanup: () => Promise<void>;
}

/**
 * Builds a libpq environment from a `postgres://` URL. Supports `sslmode`
 * (and postgres.js's `ssl=true`) in the query string; other options are
 * ignored.
 */
export async function pgConnectionFromUrl(databaseUrl: string): Promise<PgConnection> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    throw new Error('DATABASE_URL must be a postgres:// URL');

  const host = decodeURIComponent(url.hostname).replace(/^\[(.*)\]$/, '$1') || 'localhost';
  const port = url.port || '5432';
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || user;
  const password = url.password ? decodeURIComponent(url.password) : null;
  const sslmode =
    url.searchParams.get('sslmode') ??
    (['true', 'require'].includes(url.searchParams.get('ssl') ?? '') ? 'require' : null);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    PGHOST: host,
    PGPORT: port,
    PGDATABASE: database,
    PGAPPNAME: 'oci-backup',
    PGCONNECT_TIMEOUT: '15',
    // A libpq that finds no password must fail, never prompt.
    PGPASSFILE: '/dev/null',
  };
  if (user) env.PGUSER = user;
  if (sslmode) env.PGSSLMODE = sslmode;
  if (process.env.TZ) env.TZ = process.env.TZ;

  let directory: string | null = null;
  if (password !== null) {
    directory = await mkdtemp(join(tmpdir(), 'oci-pg-'));
    await chmod(directory, 0o700);
    const file = join(directory, 'pgpass');
    // libpq ignores a password file readable by group or others.
    await writeFile(
      file,
      `${['*', '*', '*', pgpassField(user || '*'), pgpassField(password)].join(':')}\n`,
      { mode: 0o600 },
    );
    env.PGPASSFILE = file;
  }

  return {
    env,
    password,
    cleanup: async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Replaces the password (raw and URL-encoded) wherever it appears. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  let result = text;
  for (const form of new Set([secret, encodeURIComponent(secret)]))
    if (form.length > 0) result = result.split(form).join('***');
  return result;
}

/** Keeps the last `limit` characters of a process's error output. */
export function captureTail(child: ChildProcess, limit = 4_000): () => string {
  let tail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    tail = (tail + chunk).slice(-limit);
  });
  return () => tail.trim();
}

/** Resolves with the exit code; rejects only when the program could not be started. */
export function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

let versionCache: { value: string | null; expiresAt: number } | null = null;

/** `pg_dump --version`, or null when it cannot be run. Cached for a few minutes. */
export async function pgDumpVersion(): Promise<string | null> {
  if (versionCache && Date.now() < versionCache.expiresAt) return versionCache.value;
  const value = await new Promise<string | null>((resolve) => {
    let output = '';
    let child: ChildProcess;
    try {
      child = spawn(pgToolPath('pg_dump'), ['--version'], {
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      });
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? output.trim() || null : null));
  });
  versionCache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * A second PostgreSQL 17 for the WAL archiver live tests: `wal_level=replica`,
 * `archive_mode=on`, `archive_timeout=60` and the PostgreSQL manual's example
 * `archive_command` (`test ! -f /archive/%f && cp %p /archive/%f`) into the
 * container's `/archive`. Its settings live in postgresql.conf, not on the
 * command line, so a test can `ALTER SYSTEM SET archive_command`.
 *
 * CI starts it with `docker run` (.github/workflows/ci.yml; GitHub Actions
 * service containers take no server arguments or files) on port 5440, the
 * local harness as the `archive-postgres` service on 15440 (docs/dev/testing.md).
 * `TEST_ARCHIVE_DATABASE_URL` names it, as a superuser.
 */
export const ARCHIVE_DIRECTORY = '/archive';

export function archiveAdminUrl(): string | null {
  return process.env.TEST_ARCHIVE_DATABASE_URL ?? null;
}

/**
 * True when the archive-enabled server answers. Locally a suite skips without
 * one, as `liveS3Available` does, so `pnpm test:live` works with only
 * PostgreSQL; in CI (`CI` set) an unset or unreachable one is an error, since a
 * skipped suite there would silently drop its coverage.
 */
export async function liveArchivePostgresAvailable(): Promise<boolean> {
  const required = Boolean(process.env.CI);
  const url = archiveAdminUrl();
  if (!url) {
    if (required)
      throw new Error(
        'CI must provide the archive-enabled PostgreSQL for the archiver suite: set TEST_ARCHIVE_DATABASE_URL.',
      );
    return false;
  }
  const client = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await client`select 1`;
    return true;
  } catch (error) {
    if (required)
      throw new Error(
        `The archive-enabled PostgreSQL is not usable: ${error instanceof Error ? error.message : String(error)}`,
      );
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

/** A login role with no privilege beyond an ordinary application role, and a URL for it. */
export async function createUnprivilegedRole(adminUrl: string): Promise<{
  url: string;
  name: string;
  drop: () => Promise<void>;
}> {
  const name = `oci_app_${randomUUID().slice(0, 8)}`.toLowerCase();
  const password = randomUUID();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Identifiers and the literal are generated here, not user input.
    await admin.unsafe(
      `create role "${name}" login nosuperuser nocreatedb nocreaterole noinherit password '${password}'`,
    );
  } finally {
    await admin.end({ timeout: 1 });
  }
  const url = new URL(adminUrl);
  url.username = name;
  url.password = password;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`drop role if exists "${name}"`);
      } finally {
        await cleanup.end({ timeout: 1 });
      }
    },
  };
}

/** Polls until `check` returns a value, or fails with `what` after `timeoutMs`. */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

import {
  ENCRYPTED_LOCATIONS,
  type EncryptedLocation,
  encryptedJsonValues,
  secretReencryptionMigrations,
  setSecretCodec,
} from '@oci/db';
import type postgres from 'postgres';
import { sql as appSql } from '../../db/index.js';
import {
  CIPHERTEXT_PREFIX,
  ciphertextKeyId,
  encryptionKeyIds,
  isCurrentCiphertext,
  reencryptSecret,
  setVersionedCiphertext,
  versionedCiphertextEnabled,
} from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { previousReleaseGone } from '../embeddings/generations.js';
import type { JobDefinition } from '../jobs/runner.js';

/**
 * Encryption key rotation (v0.11 design, item 23; docs/OPERATIONS.md,
 * "Rotating ENCRYPTION_KEY").
 *
 * - **Format gate.** v0.10 replicas read only the legacy ciphertext format,
 *   so a replica writes the versioned one (`oci:v1:<key id>:…`) only once
 *   every v0.11 post-deploy step has finished: `migrate --post`, run after the
 *   last v0.10 replica is gone (or, on a single instance, at start-up). The
 *   same gate as embedding generation 1 (embeddings/generations.ts).
 * - **Re-encryption** is one background migration per table
 *   (packages/db/src/background/reencrypt-secrets.ts), scheduled by
 *   `migrate --post` and, after a key change, by the `encryption.rotation`
 *   job here, which re-runs any that finished while values not under the
 *   current key remain. Progress is on System health, Background work.
 * - **Retiring a key**: System health says how many values still need a
 *   previous key; at zero it can be removed from ENCRYPTION_KEYS_PREVIOUS.
 */

export const ENCRYPTION_ROTATION_JOB = 'encryption.rotation';
const FORMAT_RECHECK_MS = 30_000;

/** Lets the background re-encryption, which runs in this process, use the keys. */
export function registerSecretCodec(): void {
  setSecretCodec({ isCurrent: isCurrentCiphertext, reencrypt: reencryptSecret });
}

/** Turns the versioned format on once no v0.10 replica can be running. */
export async function refreshCiphertextFormat(): Promise<boolean> {
  if (versionedCiphertextEnabled()) return true;
  const ready = await previousReleaseGone();
  if (ready) {
    setVersionedCiphertext(true);
    logger.info(
      { keyId: encryptionKeyIds().current },
      'Every replica runs v0.11: new secrets are stored in the versioned format',
    );
  }
  return ready;
}

/**
 * Checks the gate at start-up and every 30 seconds until it opens (on every
 * replica: web replicas write secrets too). Returns a function that stops it.
 */
export async function startCiphertextFormatWatch(): Promise<() => void> {
  registerSecretCodec();
  if (await refreshCiphertextFormat().catch(() => false)) return () => {};
  const timer = setInterval(() => {
    void refreshCiphertextFormat()
      .then((ready) => {
        if (ready) clearInterval(timer);
      })
      .catch(() => {});
  }, FORMAT_RECHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export interface LocationUsage {
  name: string;
  table: string;
  /** Encrypted values stored. */
  total: number;
  /** In the versioned format under ENCRYPTION_KEY. */
  current: number;
  /** In the format before v0.11 (no key named). */
  legacy: number;
  /** Values naming a previous key, by key id. */
  previous: Record<string, number>;
  /** Values naming a key that is not configured at all, by key id. */
  unknown: Record<string, number>;
}

export interface KeyUsage {
  currentKeyId: string;
  previousKeyIds: string[];
  versionedFormat: boolean;
  locations: LocationUsage[];
  total: number;
  /** Values not yet under the current key (legacy or a previous key). */
  stale: number;
  /** Values naming a key that is not configured. */
  unknown: number;
}

/** Adds `count` values that name `keyId` (null: the legacy format). */
function classify(
  usage: LocationUsage,
  keyId: string | null,
  current: string,
  previous: Set<string>,
  count = 1,
): void {
  usage.total += count;
  if (keyId === null) usage.legacy += count;
  else if (keyId === current) usage.current += count;
  else if (previous.has(keyId)) usage.previous[keyId] = (usage.previous[keyId] ?? 0) + count;
  else usage.unknown[keyId] = (usage.unknown[keyId] ?? 0) + count;
}

async function locationUsage(
  client: postgres.Sql,
  location: EncryptedLocation,
  current: string,
  previous: Set<string>,
): Promise<LocationUsage> {
  const usage: LocationUsage = {
    name: location.name,
    table: location.table,
    total: 0,
    current: 0,
    legacy: 0,
    previous: {},
    unknown: {},
  };
  for (const column of location.columns) {
    // Counted by key id in SQL; legacy values (base64, no colon) group as ''.
    const rows = await client<{ key_id: string; versioned: boolean; values: number }[]>`
      select split_part(${client(column)}, ':', 3) as key_id,
        ${client(column)} like ${`${CIPHERTEXT_PREFIX}%`} as versioned,
        count(*)::integer as values
      from ${client(location.table)}
      where ${client(column)} is not null and ${client(column)} <> ''
      group by 1, 2
    `;
    for (const row of rows) {
      classify(usage, row.versioned ? row.key_id : null, current, previous, row.values);
    }
  }
  if (location.json) {
    const rows = await client<{ document: unknown }[]>`
      select ${client(location.json)} as document from ${client(location.table)}
    `;
    for (const row of rows) {
      const document = typeof row.document === 'string' ? JSON.parse(row.document) : row.document;
      for (const value of encryptedJsonValues(document))
        classify(usage, ciphertextKeyId(value), current, previous);
    }
  }
  return usage;
}

/** Where every encrypted value stands against the configured keys. */
export async function encryptionKeyUsage(client: postgres.Sql = appSql): Promise<KeyUsage> {
  const ids = encryptionKeyIds();
  const previous = new Set(ids.previous);
  const locations: LocationUsage[] = [];
  for (const location of ENCRYPTED_LOCATIONS) {
    locations.push(await locationUsage(client, location, ids.current, previous));
  }
  const sum = (pick: (usage: LocationUsage) => number) =>
    locations.reduce((total, usage) => total + pick(usage), 0);
  const values = (record: Record<string, number>) =>
    Object.values(record).reduce((total, count) => total + count, 0);
  return {
    currentKeyId: ids.current,
    previousKeyIds: ids.previous,
    versionedFormat: versionedCiphertextEnabled(),
    locations,
    total: sum((usage) => usage.total),
    stale: sum((usage) => usage.legacy + values(usage.previous)),
    unknown: sum((usage) => values(usage.unknown)),
  };
}

/**
 * Schedules the re-encryption of every table holding values not under the
 * current key: inserts its background migration if it was never scheduled,
 * or starts a finished one again from the beginning. Paused and failed ones
 * are left to an administrator. Only once every replica reads the versioned
 * format. Returns how many it scheduled.
 */
export async function scheduleReencryption(client: postgres.Sql = appSql): Promise<number> {
  if (!(await refreshCiphertextFormat())) return 0;
  const usage = await encryptionKeyUsage(client);
  let scheduled = 0;
  for (const definition of secretReencryptionMigrations) {
    const location = usage.locations.find((entry) => entry.name === definition.name);
    if (!location) continue;
    const stale =
      location.legacy + Object.values(location.previous).reduce((total, n) => total + n, 0);
    if (stale === 0) continue;
    const rows = await client<{ name: string }[]>`
      insert into background_migration (name, table_name, batch_size, pause_ms, estimated_rows)
      values (
        ${definition.name}, ${definition.table}, ${definition.batchSize}, ${definition.pauseMs},
        (select case when c.reltuples < 0 then null else c.reltuples::bigint end
           from pg_class c where c.oid = to_regclass(${definition.table}))
      )
      on conflict (name) do update set
        status = 'pending', cursor = null, rows_processed = 0, batches = 0, attempts = 0,
        last_error = null, lease_owner = null, lease_until = null, next_run_at = null,
        throttled_reason = null, throttled_at = null, started_at = null, finished_at = null,
        updated_at = now()
      where background_migration.status = 'finished'
      returning name
    `;
    if (rows.length > 0) {
      scheduled += 1;
      logger.info(
        { migration: definition.name, values: stale },
        'Re-encrypting stored secrets under the current ENCRYPTION_KEY',
      );
    }
  }
  return scheduled;
}

/** The job that reschedules re-encryption after a key change (worker and `all` replicas). */
export function encryptionJobs(): JobDefinition[] {
  registerSecretCodec();
  return [{ name: ENCRYPTION_ROTATION_JOB, intervalMs: 60_000, run: () => scheduleReencryption() }];
}

interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/** System health: which keys stored secrets need, and whether a previous key can be retired. */
export async function encryptionHealthCheck(client: postgres.Sql = appSql): Promise<Check> {
  const usage = await encryptionKeyUsage(client);
  const base = { id: 'encryption', label: 'Encryption keys' } as const;
  const stillInUse = usage.locations.reduce(
    (total, location) =>
      total + Object.values(location.previous).reduce((sum, count) => sum + count, 0),
    0,
  );
  const legacy = usage.locations.reduce((total, location) => total + location.legacy, 0);
  if (usage.unknown > 0) {
    return {
      ...base,
      status: 'error',
      detail: `${usage.unknown} stored secret${usage.unknown === 1 ? '' : 's'} need a key that is neither ENCRYPTION_KEY nor in ENCRYPTION_KEYS_PREVIOUS; they cannot be decrypted. Add the key they were written with to ENCRYPTION_KEYS_PREVIOUS.`,
    };
  }
  const prefix = `Current key ${usage.currentKeyId}; ${usage.total} stored secret${usage.total === 1 ? '' : 's'}.`;
  const values = (count: number) => `${count} value${count === 1 ? '' : 's'}`;
  if (!usage.versionedFormat) {
    // Not a previous key: until the post-deploy phase has run, secrets (new
    // ones too) are written in the format before v0.11. A fresh install has
    // to run it once as well, which the old wording never said.
    return {
      ...base,
      status: 'warn',
      detail: `${prefix} ${values(stillInUse + legacy)} stored in the format before v0.11, because the post-deploy phase has not run. Once every replica runs this release (on a new install, once now), run migrate --post (docker compose --profile tools run --rm migrate-post); the values are then re-encrypted in the background.`,
    };
  }
  if (stillInUse + legacy > 0) {
    return {
      ...base,
      status: usage.previousKeyIds.length > 0 ? 'warn' : 'ok',
      detail: `${prefix} Previous keys still in use: ${values(stillInUse + legacy)}${legacy > 0 ? ` (${legacy} in the format before v0.11)` : ''}; re-encryption is under Background work. Keep ENCRYPTION_KEYS_PREVIOUS until this reaches 0.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    detail:
      usage.previousKeyIds.length > 0
        ? `${prefix} Previous keys still in use: none. Every secret uses the current key: remove ENCRYPTION_KEYS_PREVIOUS (${usage.previousKeyIds.length} key${usage.previousKeyIds.length === 1 ? '' : 's'}).`
        : `${prefix} Previous keys still in use: none.`,
  };
}

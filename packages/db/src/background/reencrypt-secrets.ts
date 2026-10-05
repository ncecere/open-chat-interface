import type { BackgroundMigrationDefinition, BatchTransaction } from './types.js';

/**
 * Re-encryption of stored secrets under the current `ENCRYPTION_KEY` (v0.11
 * design, item 23; docs/OPERATIONS.md, "Rotating ENCRYPTION_KEY").
 *
 * One background migration per table that holds values encrypted with
 * `ENCRYPTION_KEY`. Each batch locks the next rows in key order, rewrites
 * every value of its columns that is not already under the current key
 * (versioned prefix and key id), and leaves current values alone, so a batch
 * run twice changes nothing the second time.
 *
 * The keys live in the API's environment, so the API registers how to tell
 * and rewrite values (`setSecretCodec`); the definitions only know where the
 * values are. `migrate --post` schedules them once every replica runs
 * v0.11, which rewrites values written before v0.11 (no prefix) into the
 * versioned format; after a key change the API's `encryption.rotation` job
 * schedules them again.
 */
export interface SecretCodec {
  /** Whether a stored value is already in the current format under the current key. */
  isCurrent(value: string): boolean;
  /**
   * The value decrypted and encrypted again under the current key, in the
   * versioned format. Throws when no configured key decrypts it.
   */
  reencrypt(value: string): string;
}

let codec: SecretCodec | null = null;

/** Registered by the API at start-up; batches refuse to run without it. */
export function setSecretCodec(next: SecretCodec | null): void {
  codec = next;
}

function requireCodec(): SecretCodec {
  if (!codec) {
    throw new Error(
      'Secret re-encryption needs the API process (ENCRYPTION_KEY); this process has no secret codec',
    );
  }
  return codec;
}

/** A stored value that no configured key decrypts; named without its content. */
export class SecretReencryptionError extends Error {
  constructor(where: string, cause: unknown) {
    super(
      `Could not re-encrypt ${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'SecretReencryptionError';
  }
}

/** JSON keys whose string values are secrets encrypted with ENCRYPTION_KEY. */
export const ENCRYPTED_JSON_KEY = /^encrypted[A-Z]/;

/**
 * Rewrites every encrypted string inside a JSON document (instance settings,
 * whose encrypted fields are named `encrypted…`). Returns the new document
 * and how many values changed, or null when none did.
 */
export function reencryptJson(
  value: unknown,
  rewrite: (secret: string, path: string) => string,
  isCurrent: (secret: string) => boolean,
): { value: unknown; changed: number } | null {
  let changed = 0;
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (ENCRYPTED_JSON_KEY.test(key) && typeof child === 'string' && child !== '') {
        if (isCurrent(child)) out[key] = child;
        else {
          out[key] = rewrite(child, childPath);
          changed += 1;
        }
      } else {
        out[key] = walk(child, childPath);
      }
    }
    return out;
  };
  const next = walk(value, '');
  return changed > 0 ? { value: next, changed } : null;
}

/** Every encrypted string in a JSON document, for counting. */
export function encryptedJsonValues(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (ENCRYPTED_JSON_KEY.test(key) && typeof child === 'string' && child !== '')
        found.push(child);
      else walk(child);
    }
  };
  walk(value);
  return found;
}

/** Where secrets encrypted with ENCRYPTION_KEY are stored, one entry per table. */
export interface EncryptedLocation {
  /** Background migration name. */
  name: string;
  table: string;
  /** Text columns holding one encrypted value each. */
  columns: readonly string[];
  /** A jsonb column whose `encrypted…` fields hold encrypted values. */
  json?: string;
  description: string;
}

export const ENCRYPTED_LOCATIONS: readonly EncryptedLocation[] = [
  {
    name: '0.11.reencrypt-provider-keys',
    table: 'provider',
    columns: ['encrypted_api_key'],
    description: 'Re-encrypts model provider API keys under the current ENCRYPTION_KEY.',
  },
  {
    name: '0.11.reencrypt-connector-credentials',
    table: 'connector',
    columns: ['encrypted_shared_header_value', 'encrypted_oauth_client_secret'],
    description:
      'Re-encrypts connector shared credentials and OAuth client secrets under the current ENCRYPTION_KEY.',
  },
  {
    name: '0.11.reencrypt-connector-tokens',
    table: 'connector_account',
    columns: ['encrypted_tokens', 'encrypted_pending'],
    description:
      "Re-encrypts people's connector OAuth tokens and pending authorizations under the current ENCRYPTION_KEY.",
  },
  {
    name: '0.11.reencrypt-webhook-secrets',
    table: 'webhook_endpoint',
    columns: ['encrypted_secret'],
    description: 'Re-encrypts webhook signing secrets under the current ENCRYPTION_KEY.',
  },
  {
    name: '0.11.reencrypt-settings',
    table: 'instance_setting',
    columns: [],
    json: 'value',
    description:
      'Re-encrypts credentials in instance settings (object storage, backups, compliance export, web search, email) under the current ENCRYPTION_KEY.',
  },
];

async function reencryptBatch(
  sql: BatchTransaction,
  location: EncryptedLocation,
  cursor: string | null,
  batchSize: number,
) {
  const active = requireCodec();
  const columns = [...location.columns, ...(location.json ? [location.json] : [])];
  // Locked in this transaction, so a concurrent write waits for the batch
  // rather than being overwritten by it (or overwriting it half-way).
  const rows = await sql<Array<Record<string, unknown> & { id: string }>>`
    select id, ${sql(columns)} from ${sql(location.table)}
    where ${cursor === null ? sql`true` : sql`id > ${cursor}`}
    order by id
    limit ${batchSize}
    for update
  `;
  for (const row of rows) {
    const patch: Record<string, unknown> = {};
    for (const column of location.columns) {
      const value = row[column];
      if (typeof value !== 'string' || value === '' || active.isCurrent(value)) continue;
      try {
        patch[column] = active.reencrypt(value);
      } catch (error) {
        throw new SecretReencryptionError(`${location.table}.${column} of row ${row.id}`, error);
      }
    }
    let document: string | null = null;
    if (location.json) {
      const stored = row[location.json];
      const rewritten = reencryptJson(
        typeof stored === 'string' ? JSON.parse(stored) : stored,
        (secret, path) => {
          try {
            return active.reencrypt(secret);
          } catch (error) {
            throw new SecretReencryptionError(
              `${location.table}.${location.json} (${path}) of row ${row.id}`,
              error,
            );
          }
        },
        (secret) => active.isCurrent(secret),
      );
      if (rewritten) document = JSON.stringify(rewritten.value);
    }
    if (Object.keys(patch).length > 0) {
      await sql`update ${sql(location.table)} set ${sql(patch)} where id = ${row.id}`;
    }
    if (location.json && document !== null) {
      await sql`
        update ${sql(location.table)} set ${sql(location.json)} = ${document}::jsonb
        where id = ${row.id}
      `;
    }
  }
  const last = rows.at(-1)?.id ?? cursor;
  return { cursor: last, rows: rows.length, done: rows.length < batchSize };
}

export const secretReencryptionMigrations: readonly BackgroundMigrationDefinition[] =
  ENCRYPTED_LOCATIONS.map((location) => ({
    name: location.name,
    release: '0.11.0',
    table: `public.${location.table}`,
    description: location.description,
    // Rows are small and each value costs one decryption and one encryption.
    batchSize: 200,
    pauseMs: 50,
    batch: (sql, { cursor, batchSize }) => reencryptBatch(sql, location, cursor, batchSize),
  }));

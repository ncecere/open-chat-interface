import { attachmentOwnRows } from './attachment-own-rows.js';
import { chunkSearchFolded } from './chunk-search-folded.js';
import { messageSearchFolded } from './message-search-folded.js';
import { secretReencryptionMigrations } from './reencrypt-secrets.js';
import { TEST_BACKGROUND_MIGRATIONS } from './test-definitions.js';
import { threadConnectorUse } from './thread-connector-use.js';
import type { BackgroundMigrationDefinition } from './types.js';
import { usageRollupBackfill } from './usage-rollups.js';

export { attachmentOwnRows } from './attachment-own-rows.js';
export { CHUNK_SEARCH_FOLDED, chunkSearchFolded } from './chunk-search-folded.js';
export { MESSAGE_SEARCH_FOLDED, messageSearchFolded } from './message-search-folded.js';
export {
  ENCRYPTED_JSON_KEY,
  ENCRYPTED_LOCATIONS,
  type EncryptedLocation,
  encryptedJsonValues,
  reencryptJson,
  type SecretCodec,
  SecretReencryptionError,
  secretReencryptionMigrations,
  setSecretCodec,
} from './reencrypt-secrets.js';
export { rewriteMessagesInPlace } from './test-definitions.js';
export { THREAD_CONNECTOR_USE, threadConnectorUse } from './thread-connector-use.js';
export type {
  BackgroundBatchInput,
  BackgroundBatchResult,
  BackgroundMigrationDefinition,
  BatchTransaction,
} from './types.js';
export { usageRollupBackfill } from './usage-rollups.js';

/**
 * Every background migration this release ships, in the order they are
 * scheduled. Add a definition here (one file per migration in this folder)
 * and, if a later release depends on it, name it in `releases.json`.
 * Definitions are permanent: a release keeps every earlier one, so an
 * instance that skipped `migrate --post` can still finish it.
 */
const RELEASE_BACKGROUND_MIGRATIONS: readonly BackgroundMigrationDefinition[] = [
  // 0.11: usage events written before migration 0040 into the usage rollups.
  usageRollupBackfill,
  // 0.11: secrets encrypted with ENCRYPTION_KEY into the versioned format
  // under the current key; rescheduled by the API after a key change.
  ...secretReencryptionMigrations,
  // 0.11: forks and edits made before it get their own rows for the files they
  // share with their source (#358).
  attachmentOwnRows,
  // 0.13: the accent-folded search vector of messages written before it (#362).
  messageSearchFolded,
  // 0.13: the same for project file passages (#362).
  chunkSearchFolded,
  // 0.14: connector tools used before 0052 (or on a v0.13 replica in the upgrade
  // window) become thread_connector_use rows, for data classification (#395).
  threadConnectorUse,
];

/** Test-only definitions enabled by name, comma-separated. */
export const TEST_BACKGROUND_MIGRATIONS_ENV = 'OCI_TEST_BACKGROUND_MIGRATIONS';

/** The registered background migrations, plus any test-only ones the environment names. */
export function backgroundMigrations(
  env: Record<string, string | undefined> = process.env,
): BackgroundMigrationDefinition[] {
  const enabled = new Set(
    (env[TEST_BACKGROUND_MIGRATIONS_ENV] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return [
    ...RELEASE_BACKGROUND_MIGRATIONS,
    ...TEST_BACKGROUND_MIGRATIONS.filter((definition) => enabled.has(definition.name)),
  ];
}

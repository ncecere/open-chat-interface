import { TEST_BACKGROUND_MIGRATIONS } from './test-definitions.js';
import type { BackgroundMigrationDefinition } from './types.js';

export { rewriteMessagesInPlace } from './test-definitions.js';
export type {
  BackgroundBatchInput,
  BackgroundBatchResult,
  BackgroundMigrationDefinition,
  BatchTransaction,
} from './types.js';

/**
 * Every background migration this release ships, in the order they are
 * scheduled. Add a definition here (one file per migration in this folder)
 * and, if a later release depends on it, name it in `releases.json`.
 * Definitions are permanent: a release keeps every earlier one, so an
 * instance that skipped `migrate --post` can still finish it.
 */
const RELEASE_BACKGROUND_MIGRATIONS: readonly BackgroundMigrationDefinition[] = [];

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

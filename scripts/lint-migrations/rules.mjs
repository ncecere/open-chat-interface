// Migration linter rules: statement rules (allowable or baselined) and meta rules.

const BACKGROUND =
  'Change existing rows in a background migration (packages/db/src/background: batched, throttled, resumable; docs/dev/database.md, "Background migrations").';
const POST_DEPLOY =
  'post-deploy step (packages/db/post, run by `migrate --post` outside a transaction; docs/dev/database.md, "Post-deploy steps")';
const DROP_REASON =
  'In a post-deploy step, allow it with a reason that states the previous release no longer reads it: -- oci:lint-allow <rule>: <release> stopped reading it';

/** Statement rules. Each can be allowed inline or grandfathered in the baseline. */
export const RULES = {
  'index-not-concurrent': {
    summary: 'CREATE INDEX (or REINDEX) without CONCURRENTLY on an existing table blocks writes',
    hint: `Build the index with CREATE INDEX CONCURRENTLY in a ${POST_DEPLOY}, or allow it with a reason if the table is known to be small.`,
  },
  'concurrent-in-transaction': {
    summary: 'CONCURRENTLY cannot run inside the transactional pre-deploy migrator',
    hint: `Move the statement to a ${POST_DEPLOY}. A plain CREATE INDEX on a table created in the same release is fine in pre-deploy.`,
  },
  'alter-column-type': {
    summary: 'ALTER COLUMN TYPE on an existing table rewrites it under an ACCESS EXCLUSIVE lock',
    hint: `Add a new column, backfill it in a background migration, switch reads, then drop the old one. A binary-coercible change (varchar(n) to text) does not rewrite; allow it with that reason.`,
  },
  'volatile-default': {
    summary: 'ADD COLUMN with a volatile default, serial, identity or stored generated column',
    hint: `Add the column without the default (or with a constant), set the default separately, and backfill existing rows in a background migration. now()/CURRENT_TIMESTAMP are STABLE and do not rewrite, but give every existing row the migration's time: allow them with a reason if that is intended.`,
  },
  'set-not-null': {
    summary: 'SET NOT NULL on an existing table scans it under an ACCESS EXCLUSIVE lock',
    hint: 'First add CHECK (col IS NOT NULL) NOT VALID and validate it in a later step; SET NOT NULL then uses the validated check and skips the scan.',
  },
  'constraint-not-valid': {
    summary: 'ADD CONSTRAINT (FOREIGN KEY / CHECK) without NOT VALID on an existing table',
    hint: `Add it NOT VALID (fast), then VALIDATE CONSTRAINT in a ${POST_DEPLOY}. For a column added with REFERENCES/CHECK, add the column first and the constraint NOT VALID afterwards.`,
  },
  'unique-constraint': {
    summary:
      'UNIQUE / PRIMARY KEY / EXCLUDE on an existing table builds an index while blocking writes',
    hint: `Build a unique index CONCURRENTLY in a ${POST_DEPLOY}, then ADD CONSTRAINT ... UNIQUE USING INDEX.`,
  },
  'data-change': {
    summary: 'UPDATE / DELETE / TRUNCATE / MERGE / INSERT ... SELECT on an existing table',
    hint: `${BACKGROUND} Plain INSERT ... VALUES of seed rows is allowed.`,
  },
  'drop-column': {
    summary:
      'DROP COLUMN breaks the previous release while it still runs; allowed only in a post-deploy step, with a reason',
    hint: `Stop reading the column in release N, drop it in a ${POST_DEPLOY} of release N+1, so a rollback to N still works (docs/dev/database.md, "Removing a column"). ${DROP_REASON}.`,
    preDeployOnlyHint:
      'A pre-deploy drop cannot be allowed: move the statement to a post-deploy step.',
  },
  'drop-table': {
    summary:
      'DROP TABLE breaks the previous release while it still runs; allowed only in a post-deploy step, with a reason',
    hint: `Stop using the table in release N, drop it in a ${POST_DEPLOY} of release N+1, so a rollback to N still works. ${DROP_REASON}.`,
    preDeployOnlyHint:
      'A pre-deploy drop cannot be allowed: move the statement to a post-deploy step.',
  },
  'lock-table': {
    summary: 'LOCK TABLE holds a table lock for the rest of the migration transaction',
    hint: 'Remove it; every statement takes the lock it needs, bounded by lock_timeout.',
  },
  'refresh-not-concurrent': {
    summary: 'REFRESH MATERIALIZED VIEW without CONCURRENTLY blocks reads of the view',
    hint: 'Use REFRESH MATERIALIZED VIEW CONCURRENTLY (needs a unique index on the view).',
  },
  'vacuum-full': {
    summary: 'VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock',
    hint: 'Leave space reclamation to autovacuum, or run pg_repack outside a migration.',
  },
  cluster: {
    summary: 'CLUSTER rewrites the table under an ACCESS EXCLUSIVE lock',
    hint: 'Do not reorder tables in a migration; run pg_repack outside one if needed.',
  },
  'dynamic-sql': {
    summary: 'EXECUTE of dynamic SQL inside a DO block cannot be checked',
    hint: 'Write the statements out so they can be linted, or allow it with a reason that states what it does.',
  },
  'post-not-idempotent': {
    summary:
      'A post-deploy step is repeated after an interruption, so it must succeed when it already ran',
    hint: 'Use CREATE INDEX CONCURRENTLY IF NOT EXISTS, DROP ... IF EXISTS, DROP COLUMN IF EXISTS or ADD COLUMN IF NOT EXISTS.',
  },
  'post-transaction': {
    summary:
      'A post-deploy step runs outside a transaction: no BEGIN/COMMIT, and no DO block (which runs as one transaction and cannot build CONCURRENTLY)',
    hint: 'Write one plain statement per step; split work that must be atomic into a pre-deploy migration instead.',
  },
};

/**
 * Problems with the linter's own input. Always errors: never allowed inline
 * and never written to the baseline.
 */
export const META_RULES = {
  'parse-error': 'PostgreSQL could not parse the statement',
  'allow-missing-reason': 'oci:lint-allow needs a reason: -- oci:lint-allow <rule>: <reason>',
  'allow-unknown-rule': 'oci:lint-allow names a rule that does not exist',
  'allow-unused': 'oci:lint-allow does not match a violation of the statement below it',
  'allow-not-permitted':
    'this rule cannot be allowed in a pre-deploy migration; move the statement to a post-deploy step',
  'post-one-statement': 'a post-deploy step is exactly one statement (packages/db/post)',
  journal: 'the journal and the migration files disagree',
  'release-manifest':
    'packages/db/releases.json names a migration, post-deploy step or background migration that does not exist',
};

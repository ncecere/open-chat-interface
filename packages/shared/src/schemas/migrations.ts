import { z } from 'zod';

/**
 * Three-phase migrations and the upgrade preflight (v0.11 design, sections 1
 * and 6): what System health shows under Upgrades and Background work.
 */

export const BACKGROUND_MIGRATION_BATCH_SIZE = { min: 1, max: 100_000 } as const;
export const BACKGROUND_MIGRATION_PAUSE_MS = { min: 0, max: 600_000 } as const;

/** Administrators change how fast a migration runs; auditors only read. */
export const updateBackgroundMigrationSchema = z
  .object({
    batchSize: z
      .number()
      .int()
      .min(BACKGROUND_MIGRATION_BATCH_SIZE.min)
      .max(BACKGROUND_MIGRATION_BATCH_SIZE.max)
      .optional(),
    pauseMs: z
      .number()
      .int()
      .min(BACKGROUND_MIGRATION_PAUSE_MS.min)
      .max(BACKGROUND_MIGRATION_PAUSE_MS.max)
      .optional(),
  })
  .strict()
  .refine((value) => value.batchSize !== undefined || value.pauseMs !== undefined, {
    message: 'Change the batch size, the pause, or both',
  });
export type UpdateBackgroundMigrationInput = z.infer<typeof updateBackgroundMigrationSchema>;

export type BackgroundMigrationStatus =
  | 'not_scheduled'
  | 'pending'
  | 'running'
  | 'paused'
  | 'finished'
  | 'failed';

export interface BackgroundMigrationSummary {
  name: string;
  description: string | null;
  /** The release that introduced it; null when this release does not bundle it. */
  release: string | null;
  table: string;
  /** False for a migration a newer release scheduled: this release cannot run it. */
  bundled: boolean;
  status: BackgroundMigrationStatus;
  cursor: string | null;
  batchSize: number;
  pauseMs: number;
  rowsProcessed: number;
  batches: number;
  estimatedRows: number | null;
  tableBytes: number | null;
  /** 0 to 1, or null when it cannot be estimated. */
  progress: number | null;
  attempts: number;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  nextRunAt: string | null;
  throttledReason: string | null;
  throttledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TableEstimate {
  /** Schema-qualified. */
  name: string;
  exists: boolean;
  /** `pg_class.reltuples`; null when the table has never been analysed. */
  rows: number | null;
  /** `pg_total_relation_size`: the table, its indexes and TOAST. */
  bytes: number | null;
}

/**
 * `catalog`: independent of table size. `scan`, `rewrite`, `index`, `data`:
 * grow with the table and block writes while they run in a pre-deploy
 * migration. `concurrent-index`: builds without blocking (post-deploy only).
 * `lock`: an explicit table lock.
 */
export type StatementCostKind =
  | 'catalog'
  | 'scan'
  | 'rewrite'
  | 'index'
  | 'concurrent-index'
  | 'data'
  | 'lock';

export interface StatementEstimate {
  /** The statement, shortened. */
  summary: string;
  cost: StatementCostKind;
  tables: TableEstimate[];
  /** Seconds at most, whatever the data. */
  fast: boolean;
  /** Why it is not fast, when it is not. */
  reason: string | null;
}

export interface PendingMigration {
  tag: string;
  release: string | null;
  statements: StatementEstimate[];
  fast: boolean;
}

export interface IndexEstimate {
  name: string | null;
  table: string;
  /** Rough size of the finished index. */
  estimatedBytes: number | null;
  /** True for a btree over plain columns, sized from column statistics. */
  sizedFromStatistics: boolean;
  /** An INVALID index of this name exists (an interrupted build). */
  invalidExists: boolean;
  /** A valid index of this name already exists. */
  exists: boolean;
}

export interface PostStepSummary {
  name: string;
  release: string;
  state: 'pending' | 'started' | 'finished';
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  statement: StatementEstimate;
  index: IndexEstimate | null;
}

export interface UnfinishedRequirementSummary {
  kind: 'post-step' | 'background-migration';
  name: string;
  requiredBy: string;
  state: string;
}

export type UpgradeMode = 'current' | 'rolling' | 'window' | 'blocked';

export interface UpgradeReport {
  generatedAt: string;
  /** The release this process bundles (the running release, in the API). */
  bundled: {
    version: string;
    latestMigration: string | null;
    migrations: number;
    postSteps: number;
    backgroundMigrations: number;
  };
  database: {
    /** Never migrated: a new installation. */
    fresh: boolean;
    latestMigration: string | null;
    /** The minor release whose migrations the schema has reached, from releases.json. */
    release: string | null;
    applied: number;
    /** Applied migrations this release does not bundle (a newer release migrated it). */
    unknownNewer: number;
  };
  preDeploy: PendingMigration[];
  postDeploy: PostStepSummary[];
  background: BackgroundMigrationSummary[];
  /** Earlier work the bundled release requires that is not finished. */
  requirements: UnfinishedRequirementSummary[];
  indexes: {
    /** Indexes post-deploy steps still have to build. */
    toBuild: number;
    estimatedBytes: number;
    /** INVALID indexes anywhere in the schema (interrupted concurrent builds). */
    invalid: string[];
  };
  verdict: { mode: UpgradeMode; summary: string; reasons: string[] };
}

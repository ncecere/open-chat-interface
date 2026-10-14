import { backgroundMigrations, postStepStates, runPostMigrations } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { controlDatabaseUrl } from '../../db/control.js';
import { sql } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';
import { registerSecretCodec } from '../encryption/rotation.js';
import type { JobDefinition } from '../jobs/runner.js';
import { liveReplicas, type ReplicaInfo } from '../jobs/workers.js';
import { runBackgroundMigrations, TICK_BUDGET_MS } from './background-runner.js';
import { registerMigrationGauges } from './metrics.js';

export const BACKGROUND_MIGRATIONS_JOB = 'migrations.background';
export const POST_MIGRATIONS_JOB = 'migrations.post-deploy';

/**
 * How this replica applies post-deploy steps itself. Unset follows
 * RUN_MIGRATIONS: a replica that migrates at startup is documented as the
 * only one, so once it serves, every replica runs this release, which is the
 * condition for post-deploy work. With several replicas, leave it false and
 * run `migrate --post` after replacing them all. `auto` (#385) is for a
 * replica that does not migrate itself (the chart's worker, hooks off): it
 * applies the steps once every replica that heartbeats runs this release.
 * Releases before v0.11 send no heartbeat, so the signal is only trusted for
 * upgrades from the previous minor, the supported path.
 */
export type PostMigrationMode = 'on' | 'off' | 'when-current';

export function postMigrationMode(env = loadEnv()): PostMigrationMode {
  const setting = env.RUN_POST_MIGRATIONS ?? env.RUN_MIGRATIONS;
  return setting === 'auto' ? 'when-current' : setting ? 'on' : 'off';
}

/** Whether the job is registered on this replica (`auto` decides each time it runs). */
export function autoPostMigrations(env = loadEnv()): boolean {
  return postMigrationMode(env) !== 'off';
}

/**
 * True when every replica that sent a heartbeat runs `version`. No evidence is
 * not a green light: without Redis (`null`) or with nobody heartbeating (not
 * even this replica yet) it is false.
 */
export function allReplicasCurrent(
  replicas: ReadonlyArray<{ version: string }> | null,
  version: string,
): boolean {
  return replicas !== null && replicas.length > 0 && replicas.every((r) => r.version === version);
}

/** True when a bundled step is unfinished or a bundled background migration is unscheduled. */
export async function postWorkPending(): Promise<boolean> {
  const states = await postStepStates(sql);
  if (states.some((state) => state.state !== 'finished')) return true;
  const names = backgroundMigrations().map((definition) => definition.name);
  if (names.length === 0) return false;
  const [row] = await sql<{ scheduled: number }[]>`
    select count(*)::integer as scheduled from background_migration
    where name = any(${sql.array(names)}::text[])
  `;
  return (row?.scheduled ?? 0) < names.length;
}

/**
 * Applies pending post-deploy work, when this replica is configured to (and,
 * for `auto`, once every replica runs this release). `replicas` is the
 * heartbeat list, replaceable for tests.
 */
export async function applyPostMigrationsIfDue(
  replicas: () => Promise<ReplicaInfo[] | null> = liveReplicas,
): Promise<number> {
  const mode = postMigrationMode();
  if (mode === 'off' || !(await postWorkPending())) return 0;
  if (mode === 'when-current') {
    const current = allReplicasCurrent(await replicas().catch(() => null), APP_VERSION);
    if (!current) {
      logger.debug('Post-deploy steps wait: not every replica runs this release yet');
      return 0;
    }
  }
  const result = await runPostMigrations(controlDatabaseUrl(), { logger });
  return result.steps.filter((step) => step.outcome === 'applied').length + result.scheduled.length;
}

/** The job runner's entries for three-phase migrations (v0.11 design, section 1). */
export function migrationJobs(): JobDefinition[] {
  registerMigrationGauges();
  // The secret re-encryption migrations need ENCRYPTION_KEY, which only this
  // process has (services/encryption/rotation.ts).
  registerSecretCodec();
  const env = loadEnv();
  const jobs: JobDefinition[] = [];
  if (env.BACKGROUND_MIGRATIONS_ENABLED) {
    jobs.push({
      // Batches until its budget is spent, hands the lease back, and the
      // next tick (on any replica) continues; a little longer than the budget.
      name: BACKGROUND_MIGRATIONS_JOB,
      intervalMs: TICK_BUDGET_MS + 5_000,
      run: () => runBackgroundMigrations(),
    });
  }
  if (autoPostMigrations(env)) {
    jobs.push({
      name: POST_MIGRATIONS_JOB,
      intervalMs: 60_000,
      run: () =>
        applyPostMigrationsIfDue().catch((error) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'Post-deploy steps failed; they are retried on the next tick',
          );
          throw error;
        }),
    });
  }
  return jobs;
}

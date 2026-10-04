import type postgres from 'postgres';
import { sql as appSql } from '../../db/index.js';

/**
 * Readiness flags for code that depends on a post-deploy step or a
 * background migration (v0.11 design, section 1, "Code during the gap").
 *
 * Between `migrate` and the end of the background phase, release N runs on a
 * schema whose new index may not be built yet, or whose backfilled column is
 * still partly empty. A feature that needs one asks here and falls back
 * until it is ready, for example:
 *
 *     if (await isBackgroundMigrationDone('0.12.message-search-vector')) {
 *       // search the stored tsvector column
 *     } else {
 *       // compute to_tsvector as before
 *     }
 *
 * Finished is permanent, so a true answer is cached for the life of the
 * process; a false one for 30 seconds, so a replica notices soon after the
 * work finishes without asking the database on every request. A database
 * that cannot answer (the table does not exist yet, a lost connection) reads
 * as not ready, the safe direction.
 */

const NOT_READY_TTL_MS = 30_000;

const ready = new Set<string>();
const notReadyUntil = new Map<string, number>();

async function cached(key: string, check: () => Promise<boolean>): Promise<boolean> {
  if (ready.has(key)) return true;
  const until = notReadyUntil.get(key);
  if (until !== undefined && until > Date.now()) return false;
  let done = false;
  try {
    done = await check();
  } catch {
    done = false;
  }
  if (done) {
    ready.add(key);
    notReadyUntil.delete(key);
  } else {
    notReadyUntil.set(key, Date.now() + NOT_READY_TTL_MS);
  }
  return done;
}

/** True once `migrate --post` has finished the named step (file name without `.sql`). */
export function isPostStepDone(name: string, client: postgres.Sql = appSql): Promise<boolean> {
  return cached(`post:${name}`, async () => {
    const [row] = await client<{ done: boolean }[]>`
      select exists (
        select 1 from oci_post_migration where name = ${name} and finished_at is not null
      ) as done
    `;
    return row?.done === true;
  });
}

/** True once the named background migration has finished. */
export function isBackgroundMigrationDone(
  name: string,
  client: postgres.Sql = appSql,
): Promise<boolean> {
  return cached(`background:${name}`, async () => {
    const [row] = await client<{ done: boolean }[]>`
      select exists (
        select 1 from background_migration where name = ${name} and status = 'finished'
      ) as done
    `;
    return row?.done === true;
  });
}

/** Test seam: forget every cached answer. */
export function resetReadinessCache(): void {
  ready.clear();
  notReadyUntil.clear();
}

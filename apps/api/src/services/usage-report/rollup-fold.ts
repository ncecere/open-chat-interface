import { foldAllUsageRollupChanges } from '@oci/db';
import { sql } from '../../db/index.js';
import { isDraining } from '../../lib/drain.js';

export const USAGE_ROLLUP_FOLD_JOB = 'usage.fold-rollups';

/**
 * Folds the usage change log into the hourly rollups (migration 0040). How
 * often it runs only changes how fast reports and budget checks are, never
 * what they return: they read the change log not folded yet as well.
 */
export function foldUsageRollups(): Promise<number> {
  return foldAllUsageRollupChanges(sql, { budgetMs: 20_000, shouldStop: isDraining });
}

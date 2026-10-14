import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Readiness (services/migrations/readiness.ts) reads "not ready" whenever the
 * database cannot answer, never an error: search and the other features that
 * ask it fall back to their older path. That includes a database module that
 * has no connection to hand out at all.
 */
vi.mock('../../db/index.js', () => ({
  get sql(): never {
    throw new Error('no connection');
  },
}));

const { isBackgroundMigrationDone, isPostStepDone, resetReadinessCache } = await import(
  '../../services/migrations/readiness.js'
);

describe('readiness without a database', () => {
  beforeEach(() => resetReadinessCache());

  it('reads a post-deploy step as not done, without throwing', async () => {
    await expect(isPostStepDone('0014_message_search_folded_index')).resolves.toBe(false);
  });

  it('reads a background migration as not done, without throwing', async () => {
    await expect(isBackgroundMigrationDone('0.13.chunk-search-folded')).resolves.toBe(false);
  });
});

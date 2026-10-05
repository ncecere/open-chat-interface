-- fixture-phase: post
-- fixture: setup
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text);
-- fixture: bad
CREATE INDEX CONCURRENTLY "t_a_idx" ON "t" ("a");
-- fixture: good
CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_a_idx" ON "t" ("a");
-- fixture: allowed
-- oci:lint-allow post-not-idempotent: the runner records the step finished, and a rerun after a partial build fails clearly
CREATE INDEX CONCURRENTLY "t_a_idx" ON "t" ("a");
-- fixture: missing-reason
-- oci:lint-allow post-not-idempotent
CREATE INDEX CONCURRENTLY "t_a_idx" ON "t" ("a");

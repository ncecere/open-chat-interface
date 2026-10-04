-- fixture-phase: post
-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
DROP TABLE IF EXISTS "t";
-- fixture: good
DROP INDEX CONCURRENTLY IF EXISTS "t_unused_idx";
-- fixture: allowed
-- oci:lint-allow drop-table: release N-1 no longer reads t (it stopped in N-1)
DROP TABLE IF EXISTS "t";
-- fixture: missing-reason
-- oci:lint-allow drop-table
DROP TABLE IF EXISTS "t";

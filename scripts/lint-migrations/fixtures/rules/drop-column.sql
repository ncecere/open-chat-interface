-- fixture-phase: post
-- Drops are allowed only in post-deploy steps, and only with a reason; a
-- pre-deploy drop fails even with one (see "post-deploy rules" in the tests).
-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" DROP COLUMN IF EXISTS "a";
-- fixture: good
CREATE INDEX CONCURRENTLY IF NOT EXISTS "t_a_idx" ON "t" ("a");
-- fixture: allowed
-- oci:lint-allow drop-column: release N-1 stopped reading a (docs/dev/database.md)
ALTER TABLE "t" DROP COLUMN IF EXISTS "a";
-- fixture: missing-reason
-- oci:lint-allow drop-column
ALTER TABLE "t" DROP COLUMN IF EXISTS "a";

-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
CREATE INDEX "t_a_idx" ON "t" ("a");
-- fixture: good
CREATE TABLE "n" ("id" text PRIMARY KEY, "a" text);
--> statement-breakpoint
CREATE INDEX "n_a_idx" ON "n" ("a");
-- fixture: allowed
-- oci:lint-allow index-not-concurrent: t holds one row per organisation
CREATE INDEX "t_a_idx" ON "t" ("a");
-- fixture: missing-reason
-- oci:lint-allow index-not-concurrent
CREATE INDEX "t_a_idx" ON "t" ("a");

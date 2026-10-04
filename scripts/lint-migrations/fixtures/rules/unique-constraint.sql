-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" ADD CONSTRAINT "t_a_unique" UNIQUE ("a");
-- fixture: good
ALTER TABLE "t" ADD CONSTRAINT "t_a_unique" UNIQUE USING INDEX "t_a_unique_idx";
-- fixture: allowed
-- oci:lint-allow unique-constraint: t holds one row per organisation
ALTER TABLE "t" ADD CONSTRAINT "t_a_unique" UNIQUE ("a");
-- fixture: missing-reason
-- oci:lint-allow unique-constraint
ALTER TABLE "t" ADD CONSTRAINT "t_a_unique" UNIQUE ("a");

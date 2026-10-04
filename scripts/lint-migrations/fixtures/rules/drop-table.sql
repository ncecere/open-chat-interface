-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
DROP TABLE "t";
-- fixture: good
CREATE TABLE "scratch" ("id" text);
--> statement-breakpoint
DROP TABLE "scratch";
-- fixture: allowed
-- oci:lint-allow drop-table: unused since the previous release
DROP TABLE IF EXISTS "t";
-- fixture: missing-reason
-- oci:lint-allow drop-table
DROP TABLE IF EXISTS "t";

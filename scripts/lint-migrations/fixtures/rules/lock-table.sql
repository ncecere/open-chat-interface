-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
LOCK TABLE "t" IN SHARE MODE;
-- fixture: good
ALTER TABLE "t" ADD COLUMN "b" text;
-- fixture: allowed
-- oci:lint-allow lock-table: keeps the next two statements consistent; t is tiny
LOCK TABLE "t" IN SHARE MODE;
-- fixture: missing-reason
-- oci:lint-allow lock-table
LOCK TABLE "t" IN SHARE MODE;

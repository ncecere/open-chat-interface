-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" DROP COLUMN "a";
-- fixture: good
CREATE TABLE "n" ("id" text PRIMARY KEY, "scratch" text);
--> statement-breakpoint
ALTER TABLE "n" DROP COLUMN "scratch";
-- fixture: allowed
-- oci:lint-allow drop-column: release N-1 stopped reading a (docs/dev/database.md)
ALTER TABLE "t" DROP COLUMN IF EXISTS "a";
-- fixture: missing-reason
-- oci:lint-allow drop-column
ALTER TABLE "t" DROP COLUMN IF EXISTS "a";

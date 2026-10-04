-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE integer USING "a"::integer;
-- fixture: good
CREATE TABLE "n" ("id" text PRIMARY KEY, "a" varchar(10));
--> statement-breakpoint
ALTER TABLE "n" ALTER COLUMN "a" SET DATA TYPE text;
-- fixture: allowed
-- oci:lint-allow alter-column-type: varchar to text is binary-coercible, no rewrite
ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE text;
-- fixture: missing-reason
-- oci:lint-allow alter-column-type
ALTER TABLE "t" ALTER COLUMN "a" SET DATA TYPE text;

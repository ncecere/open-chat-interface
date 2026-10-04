-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;
-- fixture: good
ALTER TABLE "t" ADD CONSTRAINT "t_a_not_null" CHECK ("a" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "t" VALIDATE CONSTRAINT "t_a_not_null";
--> statement-breakpoint
ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;
-- fixture: allowed
-- oci:lint-allow set-not-null: t is written only by this release and is empty
ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;
-- fixture: missing-reason
-- oci:lint-allow set-not-null
ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;

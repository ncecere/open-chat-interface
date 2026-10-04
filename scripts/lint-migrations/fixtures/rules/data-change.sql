-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
UPDATE "t" SET "a" = lower("a");
-- fixture: good
INSERT INTO "u" ("id") VALUES ('seed-1'), ('seed-2') ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "n" ("id" text PRIMARY KEY);
--> statement-breakpoint
UPDATE "n" SET "id" = lower("id");
-- fixture: allowed
-- oci:lint-allow data-change: removes at most one sentinel row per organisation
DELETE FROM "t" WHERE "id" = 'legacy-sentinel';
-- fixture: missing-reason
-- oci:lint-allow data-change
DELETE FROM "t" WHERE "id" = 'legacy-sentinel';

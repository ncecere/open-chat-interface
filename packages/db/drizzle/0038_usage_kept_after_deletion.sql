-- Usage kept after an account is deleted (v0.10). See docs/dev/v0.10-design.md,
-- "Usage kept after deletion".
--
-- Deleting an account used to cascade to its usage history, so instance-wide
-- cost and usage reports and budget history changed after the fact. The
-- reporting tables now keep their rows and lose only the link to the person:
--
-- * `usage_event`  - one row per generation, embeddings call or rerank;
-- * `usage_record` - the daily rollup, the long-lived record;
-- * `quota_denial` - daily refusal counts per limit (Usage -> Limits).
--
-- Each `user_id` becomes nullable and its foreign key ON DELETE SET NULL. No
-- name, email or other identifier is copied anywhere. Per-person live state
-- (quota reservations, limit overrides, the storage counter) is still deleted
-- with the account; pending reservations by the deletion service, the rest by
-- their own cascades.
--
-- Pre-deploy safe: the previous release writes `user_id` on every row and
-- never deletes usage explicitly, so it works unchanged on this schema.
-- * DROP NOT NULL is a catalog change only; no rows are rewritten or scanned.
-- * The replacement key is added NOT VALID and deliberately never validated:
--   validating scans the whole table, and the migrator applies a release's
--   migrations in one transaction, so writes would wait for that scan. It is
--   not needed: the old key guaranteed every existing row refers to an
--   account, a NOT VALID key is still checked for every new or changed row,
--   and its ON DELETE SET NULL action fires like any other. So no statement
--   here scans or rewrites a table; each takes its lock only briefly.
-- * The old cascading key is dropped last, so a key is in force throughout.
--
-- Re-runnable: every statement is guarded, so applying it twice is harmless.
ALTER TABLE "usage_event" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_user_id_set_null_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "usage_event" DROP CONSTRAINT IF EXISTS "usage_event_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_record" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_user_id_set_null_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "usage_record" DROP CONSTRAINT IF EXISTS "usage_record_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "quota_denial" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quota_denial" ADD CONSTRAINT "quota_denial_user_id_set_null_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "quota_denial" DROP CONSTRAINT IF EXISTS "quota_denial_user_id_user_id_fk";

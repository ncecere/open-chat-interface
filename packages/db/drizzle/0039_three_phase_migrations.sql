-- Migrations in three phases (v0.11). See docs/dev/v0.11-design.md, section 1,
-- and docs/dev/database.md, "Three kinds of migration".
--
-- * `oci_post_migration`: one row per post-deploy step (packages/db/post),
--   written by `migrate --post`. A step whose row has no `finished_at` was
--   interrupted or failed and runs again next time.
-- * `background_migration`: one row per background migration
--   (packages/db/src/background), scheduled by `migrate --post` and run in
--   batches by the API's job runner. `cursor` is the last key processed; it
--   is advanced in the same transaction as the batch it describes.
--
-- Additive and pre-deploy safe: two new tables the previous release never
-- reads. Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "oci_post_migration" (
	"name" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "background_migration" (
	"name" text PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"cursor" text,
	"batch_size" integer NOT NULL,
	"pause_ms" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"rows_processed" bigint DEFAULT 0 NOT NULL,
	"batches" integer DEFAULT 0 NOT NULL,
	"estimated_rows" bigint,
	"throttled_reason" text,
	"throttled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_migration_status" CHECK ("status" in ('pending', 'running', 'paused', 'finished', 'failed')),
	CONSTRAINT "background_migration_batch_size" CHECK ("batch_size" between 1 and 100000),
	CONSTRAINT "background_migration_pause_ms" CHECK ("pause_ms" between 0 and 600000)
);

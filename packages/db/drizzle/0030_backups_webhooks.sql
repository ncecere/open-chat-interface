-- Automated backups and signed webhooks (v0.9). See docs/dev/v0.9-design.md,
-- "Automated backups" and "Observability and events", docs/admin/backups.md
-- and docs/admin/observability.md.
--
-- `backup_run` is the run history: one row per attempt, with the objects it
-- wrote, their sizes and checksums, and the verification result. Retention
-- deletes a run's objects and sets `pruned_at`; the row stays as history.
-- `backup_object_checksum` caches the SHA-256 of attachment objects, which are
-- written once and never changed, so each backup reads only new objects.
--
-- `webhook_endpoint` holds administrator-registered HTTPS endpoints and their
-- encrypted signing secret. `webhook_delivery` is the durable delivery queue
-- and its log: the job runner sends due rows, retrying with backoff.
--
-- New, empty tables only: nothing existing is rewritten, so v0.8 code keeps
-- working against this schema during a rolling upgrade.
CREATE TABLE IF NOT EXISTS "backup_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"destination" text NOT NULL,
	"key_prefix" text NOT NULL,
	"dump_key" text,
	"dump_bytes" bigint,
	"dump_sha256" text,
	"manifest_key" text,
	"attachments_key" text,
	"attachment_count" integer,
	"attachment_bytes" bigint,
	"missing_objects" integer,
	"verified" boolean DEFAULT false NOT NULL,
	"verification_detail" text,
	"error_message" text,
	"pruned_at" timestamp with time zone,
	CONSTRAINT "backup_run_trigger" CHECK ("trigger" in ('schedule', 'manual')),
	CONSTRAINT "backup_run_status" CHECK ("status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "backup_run" ADD CONSTRAINT "backup_run_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_run_started_idx" ON "backup_run" ("started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_object_checksum" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_endpoint" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"all_actions" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoint_description_length" CHECK (char_length("description") <= 200)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_delivery" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"endpoint_id" text NOT NULL,
	"audit_log_id" text,
	"event" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_delivery_status" CHECK ("status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk"
		FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_due_idx" ON "webhook_delivery" ("next_attempt_at")
	WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_delivery_endpoint_idx" ON "webhook_delivery" ("endpoint_id","created_at");

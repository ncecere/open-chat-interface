CREATE TABLE IF NOT EXISTS "deleted_object" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"user_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "job_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"details" jsonb
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "storage_usage" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"live_bytes" bigint DEFAULT 0 NOT NULL,
	"live_file_count" integer DEFAULT 0 NOT NULL,
	"pending_bytes" bigint DEFAULT 0 NOT NULL,
	"pending_file_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "storage_policy" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"max_total_bytes" bigint,
	"max_file_count" integer,
	"max_file_bytes" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quota_policy_model" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"policy_id" text NOT NULL,
	"model_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "storage_policy" ADD CONSTRAINT "storage_policy_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_policy_model" ADD CONSTRAINT "quota_policy_model_policy_id_quota_policy_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "public"."quota_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "deleted_reason" text;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN IF NOT EXISTS "deleted_reason" text;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN IF NOT EXISTS "reserved_cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_event" ADD COLUMN IF NOT EXISTS "reserved_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deleted_object_pending_idx" ON "deleted_object" USING btree ("deleted_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deleted_object_key_idx" ON "deleted_object" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_run_name_started_idx" ON "job_run" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_usage_user_idx" ON "storage_usage" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_policy_org_role_unique" ON "storage_policy" USING btree ("organization_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quota_policy_model_unique" ON "quota_policy_model" USING btree ("policy_id","model_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_policy_model_slug_idx" ON "quota_policy_model" USING btree ("model_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_deleted_idx" ON "thread" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_deleted_idx" ON "attachment" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_event_occurred_idx" ON "usage_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_event_model_idx" ON "usage_event" USING btree ("model_slug");--> statement-breakpoint

-- Attachments now die with the message they were sent on.
--
-- SET NULL stranded them: deleting a thread cascaded its messages, detached
-- every attachment, and left both the row and its blob behind permanently. A
-- detached row also read as "never sent", so it could be attached again.
ALTER TABLE "attachment" DROP CONSTRAINT IF EXISTS "attachment_message_id_message_id_fk";--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "attachment" ADD CONSTRAINT "attachment_message_id_message_id_fk"
		FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- Queues an attachment's blob for deletion whenever its row disappears.
--
-- This is the only reliable interception point: ON DELETE CASCADE from thread
-- or user removal never calls the application, so every blob deleted that way
-- previously leaked. Explicit deletes go through the same trigger, giving one
-- code path and one retry story.
CREATE OR REPLACE FUNCTION oci_enqueue_deleted_attachment_object()
RETURNS TRIGGER AS $$
BEGIN
	IF OLD."storage_key" IS NOT NULL AND OLD."storage_key" <> 'pending' THEN
		INSERT INTO "deleted_object" ("storage_key", "size_bytes", "user_id")
		VALUES (OLD."storage_key", COALESCE(OLD."size_bytes", 0), OLD."user_id");
	END IF;

	IF OLD."thumbnail_key" IS NOT NULL THEN
		INSERT INTO "deleted_object" ("storage_key", "size_bytes", "user_id")
		VALUES (OLD."thumbnail_key", 0, OLD."user_id");
	END IF;

	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "attachment_enqueue_deleted_object" ON "attachment";--> statement-breakpoint

CREATE TRIGGER "attachment_enqueue_deleted_object"
	AFTER DELETE ON "attachment"
	FOR EACH ROW EXECUTE FUNCTION oci_enqueue_deleted_attachment_object();
--> statement-breakpoint

-- Seed counters from existing rows so quotas are accurate on first boot.
INSERT INTO "storage_usage" ("organization_id", "user_id", "live_bytes", "live_file_count")
SELECT "organization_id", "user_id", COALESCE(SUM("size_bytes"), 0), COUNT(*)
FROM "attachment"
GROUP BY "organization_id", "user_id"
ON CONFLICT ("user_id") DO NOTHING;

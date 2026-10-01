-- Where an imported conversation came from. Both are null for conversations
-- started here. The source id makes re-importing the same export idempotent:
-- a conversation already imported for this person is skipped, not duplicated.
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "import_source" text;
--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "import_source_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_import_source_unique"
	ON "thread" ("user_id","import_source","import_source_id")
	WHERE "import_source_id" IS NOT NULL;
--> statement-breakpoint
-- One uploaded ChatGPT or Claude export and its processing state. The upload
-- itself lives in object storage until processing finishes, so a restart
-- resumes from the stored file rather than asking the person to upload again.
CREATE TABLE IF NOT EXISTS "conversation_import" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_key" text,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_import" ADD CONSTRAINT "conversation_import_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_import" ADD CONSTRAINT "conversation_import_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_import_user_idx" ON "conversation_import" ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_import_status_idx" ON "conversation_import" ("status","updated_at");
--> statement-breakpoint
-- A deleted account cascades its import rows away without the application
-- seeing it; queue any upload still held so the blob does not leak.
CREATE OR REPLACE FUNCTION oci_queue_deleted_import_upload() RETURNS trigger AS $$
BEGIN
  IF OLD.storage_key IS NOT NULL THEN
    INSERT INTO deleted_object (storage_key, size_bytes, user_id)
    VALUES (OLD.storage_key, OLD.size_bytes, OLD.user_id);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS conversation_import_queue_upload ON conversation_import;
--> statement-breakpoint
CREATE TRIGGER conversation_import_queue_upload
AFTER DELETE ON conversation_import FOR EACH ROW EXECUTE FUNCTION oci_queue_deleted_import_upload();

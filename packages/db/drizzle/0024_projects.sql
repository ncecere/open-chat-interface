-- Projects: a person's conversations grouped under shared instructions and
-- files.
--
-- Project files reuse the attachment table (attachment.project_id) rather than
-- a join table, so storage allowances, extraction, both storage drivers, the
-- delete triggers from migrations 0011 and 0020 (queue the blob, release the
-- counted bytes) and storage reconciliation all apply unchanged. A file belongs
-- to a project or to a message, never both.
--
-- Deleting a project detaches its conversations (ON DELETE SET NULL) and
-- cascades its files away, which fires the attachment delete triggers.
--
-- Migrations run inside one transaction, so the indexes below cannot be built
-- CONCURRENTLY. The new columns are nullable without defaults (no rewrite) and
-- both indexes are partial on a column that starts entirely null, so they
-- build quickly even on a large table; adding the foreign keys still scans
-- `thread` and `attachment` once to validate them.
CREATE TABLE IF NOT EXISTS "project" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_name_length" CHECK (char_length("name") BETWEEN 1 AND 100),
	CONSTRAINT "project_instructions_length" CHECK (char_length("instructions") <= 8000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project" ADD CONSTRAINT "project_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_user_idx" ON "project" ("user_id","updated_at");
--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread" ADD CONSTRAINT "thread_project_id_project_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_project_idx" ON "thread" ("project_id","updated_at")
	WHERE "project_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attachment" ADD CONSTRAINT "attachment_project_id_project_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attachment" ADD CONSTRAINT "attachment_single_owner"
		CHECK ("project_id" IS NULL OR "message_id" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachment_project_idx" ON "attachment" ("project_id")
	WHERE "project_id" IS NOT NULL;

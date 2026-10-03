-- User memory (v0.9). Short notes about a person that OCI includes in their
-- system prompt, made by the model's `remember` tool or by the person in
-- Settings -> Memory. Each row belongs to one person and cascades with them.
-- The conversation and message a tool-made memory came from are recorded for
-- reference only and are set to null when that conversation is deleted. See
-- docs/dev/v0.9-design.md, "User memory".
--
-- `user_preference.memory_enabled` is the person's own opt-in, off by default.
-- Adding a column with a constant default is a catalog change in PostgreSQL
-- (no table rewrite); it takes a brief ACCESS EXCLUSIVE lock on
-- `user_preference`. v0.8 replicas name their columns explicitly, so they
-- neither read nor write it, and rows they insert get the default (off).
--
-- Migrations run inside one transaction; the new table is empty, so nothing
-- existing is rewritten. Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "user_memory" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"source" text NOT NULL,
	"thread_id" text,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_memory_source" CHECK ("source" in ('tool', 'person')),
	CONSTRAINT "user_memory_content_length" CHECK (char_length("content") BETWEEN 1 AND 500)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_message_id_message_id_fk"
		FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_user_idx" ON "user_memory" ("user_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_updated_idx" ON "user_memory" ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_thread_idx" ON "user_memory" ("thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_message_idx" ON "user_memory" ("message_id");
--> statement-breakpoint
ALTER TABLE "user_preference" ADD COLUMN IF NOT EXISTS "memory_enabled" boolean DEFAULT false NOT NULL;

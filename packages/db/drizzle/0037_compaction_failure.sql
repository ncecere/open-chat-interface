-- Failed summaries are reported (v0.10). See docs/dev/v0.10-design-artifacts.md.
--
-- When a summary a person asked for ("Summarise earlier messages now") fails
-- in the background, the queue records why here: at most one row per thread,
-- with a reason category and the request's instructions (so Retry asks for
-- the same summary). Automatic summaries are never recorded. The row goes
-- when the person dismisses it, asks again, or a later summary succeeds.
--
-- Additive and pre-deploy safe: a new table the previous release never reads.
-- Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "conversation_compaction_failure" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"instructions" text,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compaction_failure_reason" CHECK ("reason" in ('allowance', 'model_error', 'nothing_to_summarise', 'timeout')),
	CONSTRAINT "conversation_compaction_failure_instructions_length" CHECK ("instructions" IS NULL OR char_length("instructions") <= 2000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction_failure" ADD CONSTRAINT "conversation_compaction_failure_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction_failure" ADD CONSTRAINT "conversation_compaction_failure_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_failure_user_idx" ON "conversation_compaction_failure" ("user_id");

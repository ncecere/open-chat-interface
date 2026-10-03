-- Conversation compaction (v0.9). When a conversation outgrows the model's
-- input budget, its oldest turns are summarised instead of dropped. Each
-- compaction is one row: the summary, the first message still sent verbatim
-- (`first_kept_message_id`, always a user message), how much was summarised,
-- why (automatic or manual) and what the summary cost. Messages are never
-- deleted or changed; the newest row of a thread is the one in use. See
-- docs/dev/v0.9-design.md, "Long conversations: compaction".
--
-- Summaries are made in the background, never while a reply waits:
-- `conversation_compaction_job` holds at most one queued or running request
-- per conversation (the primary key makes requests idempotent). The job
-- runner and an in-process kick claim rows with `for update skip locked` and
-- a lease, so several API replicas never summarise one conversation twice
-- and a request survives a restart.
--
-- Rows cascade with their thread, their owner and their first kept message,
-- so deleting a conversation, an account or a message never leaves a summary
-- (or a queued request) pointing at nothing.
--
-- Migrations run inside one transaction: the tables are new and empty, so
-- nothing existing is rewritten or locked beyond validating foreign keys on
-- empty tables. API replicas from v0.8 never read them.
CREATE TABLE IF NOT EXISTS "conversation_compaction" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"first_kept_message_id" text NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"messages_summarized" integer NOT NULL,
	"tokens_summarized" integer NOT NULL,
	"model_slug" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compaction_reason" CHECK ("reason" in ('automatic', 'manual')),
	CONSTRAINT "conversation_compaction_summary_length" CHECK (char_length("summary") BETWEEN 1 AND 200000),
	CONSTRAINT "conversation_compaction_counts" CHECK ("messages_summarized" >= 0 AND "tokens_summarized" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction" ADD CONSTRAINT "conversation_compaction_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction" ADD CONSTRAINT "conversation_compaction_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction" ADD CONSTRAINT "conversation_compaction_first_kept_message_id_message_id_fk"
		FOREIGN KEY ("first_kept_message_id") REFERENCES "message"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_thread_idx" ON "conversation_compaction" ("thread_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_message_idx" ON "conversation_compaction" ("first_kept_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_user_idx" ON "conversation_compaction" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_compaction_job" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"model_slug" text NOT NULL,
	"instructions" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"rerun" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_compaction_job_reason" CHECK ("reason" in ('automatic', 'manual')),
	CONSTRAINT "conversation_compaction_job_status" CHECK ("status" in ('pending', 'running')),
	CONSTRAINT "conversation_compaction_job_instructions_length" CHECK ("instructions" IS NULL OR char_length("instructions") <= 2000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction_job" ADD CONSTRAINT "conversation_compaction_job_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "conversation_compaction_job" ADD CONSTRAINT "conversation_compaction_job_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_job_due_idx" ON "conversation_compaction_job" ("status","run_after");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_compaction_job_user_idx" ON "conversation_compaction_job" ("user_id");

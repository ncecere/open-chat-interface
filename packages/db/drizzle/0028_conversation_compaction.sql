-- Conversation compaction (v0.9). When a conversation outgrows the model's
-- input budget, its oldest turns are summarised instead of dropped. Each
-- compaction is one row: the summary, the first message still sent verbatim
-- (`first_kept_message_id`, always a user message), how much was summarised,
-- why (automatic, manual, overflow) and what the summary cost. Messages are
-- never deleted or changed; the newest row of a thread is the one in use. See
-- docs/dev/v0.9-design.md, "Long conversations: compaction".
--
-- Rows cascade with their thread, their owner and their first kept message,
-- so deleting a conversation, an account or a message never leaves a summary
-- pointing at nothing.
--
-- Migrations run inside one transaction: the table is new and empty, so
-- nothing existing is rewritten or locked beyond validating foreign keys on an
-- empty table. API replicas from v0.8 never read it.
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
	CONSTRAINT "conversation_compaction_reason" CHECK ("reason" in ('automatic', 'manual', 'overflow')),
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

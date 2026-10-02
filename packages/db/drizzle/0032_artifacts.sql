-- Artifacts (v0.9). HTML pages, SVG images, Mermaid diagrams and Markdown
-- documents kept as versioned objects of their own. See docs/dev/v0.9-design.md,
-- "Artifacts", and docs/user/artifacts.md.
--
-- `artifact` belongs to a conversation, its owner and the reply that created
-- it, and cascades with each of them, so deleting a conversation (including
-- the trash purge, retention and temporary-chat expiry) or an account never
-- leaves an artifact behind. `source_key` records where it came from: a fenced
-- block of the reply (`block:<n>`) or a tool call (`tool:<call id>`); the
-- unique (message_id, source_key) index makes detection and tool calls
-- idempotent when they are repeated.
--
-- `artifact_version` holds every version's content. Versions are never changed.
-- Their `size_bytes` count towards the owner's storage (summed directly, so no
-- counter can drift) while the conversation is not in the trash.
--
-- New, empty tables only: nothing existing is rewritten, so v0.8 code keeps
-- working against this schema during a rolling upgrade.
CREATE TABLE IF NOT EXISTS "artifact" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_kind" CHECK ("kind" in ('html', 'svg', 'mermaid', 'markdown')),
	CONSTRAINT "artifact_title_length" CHECK (char_length("title") BETWEEN 1 AND 200),
	CONSTRAINT "artifact_source_key_length" CHECK (char_length("source_key") BETWEEN 1 AND 300),
	CONSTRAINT "artifact_current_version" CHECK ("current_version" >= 1)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "artifact" ADD CONSTRAINT "artifact_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "artifact" ADD CONSTRAINT "artifact_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "artifact" ADD CONSTRAINT "artifact_message_id_message_id_fk"
		FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_message_source_unique" ON "artifact" ("message_id","source_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_thread_idx" ON "artifact" ("thread_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_user_idx" ON "artifact" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_version" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"source" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_version_number" CHECK ("version" >= 1),
	CONSTRAINT "artifact_version_source" CHECK ("source" in ('reply', 'person')),
	CONSTRAINT "artifact_version_size" CHECK ("size_bytes" >= 0 AND "size_bytes" <= 524288 AND octet_length("content") = "size_bytes")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fk"
		FOREIGN KEY ("artifact_id") REFERENCES "artifact"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_message_id_message_id_fk"
		FOREIGN KEY ("message_id") REFERENCES "message"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_version_unique" ON "artifact_version" ("artifact_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_version_message_idx" ON "artifact_version" ("message_id");

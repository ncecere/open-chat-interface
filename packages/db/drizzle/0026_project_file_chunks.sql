-- Keyword search over large project files (v0.8). A project file's extracted
-- text is split into overlapping chunks, each with a stored 'simple' full-text
-- vector (the configuration conversation search uses since migration 0023), so
-- a project too large to send whole can contribute the passages that best
-- match a message. See docs/dev/tools-design.md, "Large project files".
--
-- `project_file_index` records which files have been chunked; its row is the
-- claim on indexing a file. Files added before this migration have no row and
-- are chunked by the `projects.index-files` background job after the upgrade;
-- until then they are used whole, as in v0.7.
--
-- Both tables cascade from `attachment`, so chunks go with their file, with
-- its project (which cascades its files) and with the account.
--
-- Migrations run inside one transaction: the tables are new and empty, so the
-- GIN index builds instantly and nothing existing is rewritten or locked
-- beyond the foreign-key validation of two empty tables.
CREATE TABLE IF NOT EXISTS "project_file_index" (
	"attachment_id" text PRIMARY KEY NOT NULL,
	"chunk_count" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_file_index_chunk_count" CHECK ("chunk_count" BETWEEN 0 AND 2000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_file_index" ADD CONSTRAINT "project_file_index_attachment_id_attachment_id_fk"
		FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_file_chunk" (
	"attachment_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"content" text NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "content")) STORED,
	CONSTRAINT "project_file_chunk_pk" PRIMARY KEY ("attachment_id","ordinal"),
	CONSTRAINT "project_file_chunk_ordinal" CHECK ("ordinal" >= 0 AND "ordinal" < 2000),
	CONSTRAINT "project_file_chunk_offsets" CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset"),
	CONSTRAINT "project_file_chunk_content_length" CHECK (char_length("content") <= 4000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_file_chunk" ADD CONSTRAINT "project_file_chunk_attachment_id_attachment_id_fk"
		FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_file_chunk_search_idx" ON "project_file_chunk" USING gin ("search");

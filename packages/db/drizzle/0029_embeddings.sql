-- Meaning-based search for project files (v0.9). See docs/dev/v0.9-design.md,
-- "Meaning-based search for project files".
--
-- The embeddings themselves are stored in `project_file_embedding`, which this
-- migration deliberately does not create: its `vector(n)` column needs the
-- pgvector extension, which OCI never enables itself (an operator runs
-- `CREATE EXTENSION vector`), and `n` depends on the embeddings model an
-- administrator chooses. The application creates that table at runtime, under
-- an advisory lock, once both are in place.
--
-- `project_file_embedding_failure` needs no extension: it records project
-- files whose passages could not be embedded with the current model, so the
-- background job backs off instead of retrying them on every tick. It
-- cascades from `attachment`, like the chunks it refers to.
--
-- The table is new and empty, so nothing existing is rewritten or locked
-- beyond validating one foreign key. v0.8 code never reads it, so v0.8
-- replicas keep working during a rolling upgrade.
CREATE TABLE IF NOT EXISTS "project_file_embedding_failure" (
	"attachment_id" text PRIMARY KEY NOT NULL,
	"model_key" text NOT NULL,
	"failures" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"retry_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_file_embedding_failure_failures" CHECK ("failures" > 0),
	CONSTRAINT "project_file_embedding_failure_error_length" CHECK (char_length("last_error") <= 500)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_file_embedding_failure" ADD CONSTRAINT "project_file_embedding_failure_attachment_id_attachment_id_fk"
		FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_file_embedding_failure_retry_idx" ON "project_file_embedding_failure" USING btree ("retry_at");

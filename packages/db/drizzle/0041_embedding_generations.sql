-- Embedding generations (v0.11 design, sections 7 and 8). See
-- docs/dev/database.md, "Embedding generations".
--
-- Each embeddings configuration (provider, model and dimensions) is a
-- generation with its own vector table. Changing the model creates
-- generation n+1 and fills it in the background while searches keep using
-- generation n; when n+1 covers every passage (or an administrator forces
-- it) one transaction makes it current, and generation n is dropped after a
-- grace period.
--
-- * `embedding_generation`: one row per generation. `state` is `filling`,
--   `current`, `retired` (searched no more, its table kept until
--   `drop_after`), `cancelled` (a rebuild abandoned before its switch) or
--   `dropped` (its table is gone; the row stays as history). At most one
--   generation is current and at most one is filling.
-- * `embedding_generation_failure`: files whose passages could not be
--   embedded for one generation, so its jobs back off instead of retrying
--   them every tick. Replaces `project_file_embedding_failure` for this
--   release, whose single row per file could not hold two generations; the
--   previous release still writes that table during a rolling upgrade, so it
--   stays until a later release drops it.
--
-- The vector tables themselves are not created here: their `vector(n)`
-- column needs the pgvector extension, which an operator enables, and `n`
-- depends on the model. The application creates them at runtime. Generation
-- 1 keeps the name the previous release reads and writes,
-- `project_file_embedding`, so nothing is renamed or copied: a rename would
-- take an exclusive lock and, worse, leave v0.10 replicas still running
-- during the upgrade to re-create an empty table under the old name and
-- embed every passage into it again. Later generations are named
-- `project_file_embedding_g<n>`; the check below ties the name to the number,
-- so a table name is never free text.
--
-- Additive and pre-deploy safe: two new, empty tables and their indexes. The
-- previous release never reads them.
CREATE TABLE IF NOT EXISTS "embedding_generation" (
	"id" integer PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"dimensions" integer NOT NULL,
	"model_key" text NOT NULL,
	"input_price_micros" bigint,
	"state" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"switched_at" timestamp with time zone,
	"switch_forced" boolean DEFAULT false NOT NULL,
	"retired_at" timestamp with time zone,
	"drop_after" timestamp with time zone,
	"dropped_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_generation_id_positive" CHECK ("id" > 0),
	CONSTRAINT "embedding_generation_table_name" CHECK ("table_name" = CASE WHEN "id" = 1 THEN 'project_file_embedding' ELSE 'project_file_embedding_g' || "id"::text END),
	CONSTRAINT "embedding_generation_dimensions" CHECK ("dimensions" > 0 AND "dimensions" <= 16000),
	CONSTRAINT "embedding_generation_state" CHECK ("state" IN ('filling', 'current', 'retired', 'cancelled', 'dropped')),
	CONSTRAINT "embedding_generation_price" CHECK ("input_price_micros" IS NULL OR "input_price_micros" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "embedding_generation_one_current" ON "embedding_generation" ("state") WHERE "state" = 'current';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "embedding_generation_one_filling" ON "embedding_generation" ("state") WHERE "state" = 'filling';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "embedding_generation_failure" (
	"generation_id" integer NOT NULL,
	"attachment_id" text NOT NULL,
	"failures" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"retry_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_generation_failure_pk" PRIMARY KEY ("generation_id", "attachment_id"),
	CONSTRAINT "embedding_generation_failure_generation_fk" FOREIGN KEY ("generation_id") REFERENCES "embedding_generation"("id") ON DELETE cascade,
	CONSTRAINT "embedding_generation_failure_attachment_fk" FOREIGN KEY ("attachment_id") REFERENCES "attachment"("id") ON DELETE cascade,
	CONSTRAINT "embedding_generation_failure_failures" CHECK ("failures" > 0),
	CONSTRAINT "embedding_generation_failure_error_length" CHECK (char_length("last_error") <= 500)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedding_generation_failure_attachment_idx" ON "embedding_generation_failure" ("attachment_id");

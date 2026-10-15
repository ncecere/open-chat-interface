-- Data classification (v0.14, #395, SPEC-data-classification.md).
--
-- Administrators define named data classes (`data_class`), approve models for
-- them (`model_data_class`) and say which classes a connector carries
-- (`connector_data_class`). A conversation carries the labels of its project
-- (`project_data_class`), the classes of the connectors whose tools it has used
-- (`thread_connector_use`, the sticky fact; classes are read from the connector
-- at decision time) and labels a person adds (`thread_data_class`, source
-- `person`). OCI refuses or warns when a labelled conversation would reach a
-- model that is not approved for every class it carries.
--
-- Join tables, not arrays: a deleted class cannot leave a dangling id, and
-- "which models are approved for X" and "is X in use" are indexed lookups.
-- The class's name lives in `data_class` only, so a rename touches one row.
-- Label tables restrict deleting a class that is in use; approvals cascade.
--
-- A label is never lost as a side effect of something else. Moving a
-- conversation out of a project, deleting a project, and deleting a connector
-- turn the labels it gave into `thread_data_class` rows of source `kept`, by
-- triggers, so every writer is covered: this release, and the previous one
-- during a rolling upgrade (the precedent is 0048). A fork or an edit-branch
-- copies its parent's labels and connector uses the same way.
--
-- Additive and pre-deploy safe: new tables (exempt from the linter, being new
-- and empty), one nullable column without a default (no rewrite), functions
-- and triggers (a brief SHARE ROW EXCLUSIVE lock on thread, project and
-- connector, inside the migrator's lock timeout and retries). The previous
-- release reads none of it. Connector uses made before this migration are
-- found by the background migration `0.14.thread-connector-use`.

CREATE TABLE IF NOT EXISTS "data_class" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	-- A retired class is hidden from pickers and refuses new labels; what it
	-- labels and approves still counts.
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_class_name_length" CHECK (char_length("name") BETWEEN 1 AND 60),
	CONSTRAINT "data_class_description_length" CHECK (char_length("description") <= 280)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "data_class" ADD CONSTRAINT "data_class_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "data_class_name_unique" ON "data_class" ("organization_id", lower("name"));
--> statement-breakpoint
-- The approvals: which classes a model may receive. A model with no row here
-- is approved for nothing (deny by default).
CREATE TABLE IF NOT EXISTS "model_data_class" (
	"model_id" text NOT NULL,
	"data_class_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_data_class_pk" PRIMARY KEY ("model_id", "data_class_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_data_class" ADD CONSTRAINT "model_data_class_model_id_model_id_fk"
		FOREIGN KEY ("model_id") REFERENCES "model"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_data_class" ADD CONSTRAINT "model_data_class_data_class_id_data_class_id_fk"
		FOREIGN KEY ("data_class_id") REFERENCES "data_class"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_data_class_class_idx" ON "model_data_class" ("data_class_id");
--> statement-breakpoint
-- What a connector carries. A connector with no row is unlabelled (carries
-- nothing); `connector.data_classes_reviewed_at` says whether anyone looked.
CREATE TABLE IF NOT EXISTS "connector_data_class" (
	"connector_id" text NOT NULL,
	"data_class_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_data_class_pk" PRIMARY KEY ("connector_id", "data_class_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector_data_class" ADD CONSTRAINT "connector_data_class_connector_id_connector_id_fk"
		FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector_data_class" ADD CONSTRAINT "connector_data_class_data_class_id_data_class_id_fk"
		FOREIGN KEY ("data_class_id") REFERENCES "data_class"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_data_class_class_idx" ON "connector_data_class" ("data_class_id");
--> statement-breakpoint
-- Labels on a project; every conversation in it carries them. `locked` is set
-- by an administrator: only an administrator removes it.
CREATE TABLE IF NOT EXISTS "project_data_class" (
	"project_id" text NOT NULL,
	"data_class_id" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_data_class_pk" PRIMARY KEY ("project_id", "data_class_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_data_class" ADD CONSTRAINT "project_data_class_project_id_project_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_data_class" ADD CONSTRAINT "project_data_class_data_class_id_data_class_id_fk"
		FOREIGN KEY ("data_class_id") REFERENCES "data_class"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_data_class" ADD CONSTRAINT "project_data_class_created_by_user_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_data_class_class_idx" ON "project_data_class" ("data_class_id");
--> statement-breakpoint
-- Labels on a conversation. `person`: added by its owner, removable by them.
-- `kept`: frozen when the project or connector that gave it went away (or the
-- conversation left the project); `origin` says which, and the owner cannot
-- remove it. Forks and edit-branches copy both kinds.
CREATE TABLE IF NOT EXISTS "thread_data_class" (
	"thread_id" text NOT NULL,
	"data_class_id" text NOT NULL,
	"source" text NOT NULL,
	"origin" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_data_class_pk" PRIMARY KEY ("thread_id", "data_class_id", "source"),
	CONSTRAINT "thread_data_class_source" CHECK ("source" in ('person', 'kept'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_data_class" ADD CONSTRAINT "thread_data_class_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_data_class" ADD CONSTRAINT "thread_data_class_data_class_id_data_class_id_fk"
		FOREIGN KEY ("data_class_id") REFERENCES "data_class"("id") ON DELETE restrict;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_data_class" ADD CONSTRAINT "thread_data_class_created_by_user_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_data_class_class_idx" ON "thread_data_class" ("data_class_id");
--> statement-breakpoint
-- The sticky fact: this conversation has used a tool of this connector. Its
-- classes are read from the connector at decision time, so classifying a
-- connector later reaches conversations that used it earlier.
CREATE TABLE IF NOT EXISTS "thread_connector_use" (
	"thread_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_connector_use_pk" PRIMARY KEY ("thread_id", "connector_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_connector_use" ADD CONSTRAINT "thread_connector_use_thread_id_thread_id_fk"
		FOREIGN KEY ("thread_id") REFERENCES "thread"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_connector_use" ADD CONSTRAINT "thread_connector_use_connector_id_connector_id_fk"
		FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_connector_use_connector_idx" ON "thread_connector_use" ("connector_id");
--> statement-breakpoint
-- When an administrator last said what the connector carries (possibly
-- nothing). Null shows "Not reviewed". No default: no rewrite.
ALTER TABLE "connector" ADD COLUMN IF NOT EXISTS "data_classes_reviewed_at" timestamp with time zone;
--> statement-breakpoint
-- 1. A conversation leaves a project (the move, or the project's deletion
-- setting project_id to null): the project's classes stay with it.
CREATE OR REPLACE FUNCTION "thread_keep_project_classes"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "thread_data_class" ("thread_id", "data_class_id", "source", "origin")
	SELECT NEW."id", pdc."data_class_id", 'kept', 'project'
	FROM "project_data_class" pdc
	WHERE pdc."project_id" = OLD."project_id"
	ON CONFLICT DO NOTHING;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "thread_keep_project_classes" ON "thread";
--> statement-breakpoint
CREATE TRIGGER "thread_keep_project_classes" BEFORE UPDATE OF "project_id" ON "thread"
	FOR EACH ROW WHEN (OLD."project_id" IS NOT NULL AND OLD."project_id" IS DISTINCT FROM NEW."project_id")
	EXECUTE FUNCTION "thread_keep_project_classes"();
--> statement-breakpoint
-- 2. A project is deleted: every conversation in it keeps its classes. BEFORE,
-- because the cascade to project_data_class and the SET NULL on
-- thread.project_id are AFTER triggers with no guaranteed order between them.
CREATE OR REPLACE FUNCTION "project_keep_classes_on_delete"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "thread_data_class" ("thread_id", "data_class_id", "source", "origin")
	SELECT t."id", pdc."data_class_id", 'kept', 'project'
	FROM "thread" t
	JOIN "project_data_class" pdc ON pdc."project_id" = OLD."id"
	WHERE t."project_id" = OLD."id"
	ON CONFLICT DO NOTHING;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_keep_classes_on_delete" ON "project";
--> statement-breakpoint
CREATE TRIGGER "project_keep_classes_on_delete" BEFORE DELETE ON "project"
	FOR EACH ROW EXECUTE FUNCTION "project_keep_classes_on_delete"();
--> statement-breakpoint
-- 3. A connector is deleted: the conversations that used it keep what it
-- carried, since their use rows cascade away with it.
CREATE OR REPLACE FUNCTION "connector_keep_classes_on_delete"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "thread_data_class" ("thread_id", "data_class_id", "source", "origin")
	SELECT u."thread_id", cdc."data_class_id", 'kept', 'connector: ' || OLD."name"
	FROM "thread_connector_use" u
	JOIN "connector_data_class" cdc ON cdc."connector_id" = OLD."id"
	WHERE u."connector_id" = OLD."id"
	ON CONFLICT DO NOTHING;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "connector_keep_classes_on_delete" ON "connector";
--> statement-breakpoint
CREATE TRIGGER "connector_keep_classes_on_delete" BEFORE DELETE ON "connector"
	FOR EACH ROW EXECUTE FUNCTION "connector_keep_classes_on_delete"();
--> statement-breakpoint
-- 4. A fork or an edit-branch (a thread with a parent) starts with its
-- parent's labels and connector uses.
CREATE OR REPLACE FUNCTION "thread_copy_parent_classes"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "thread_data_class" ("thread_id", "data_class_id", "source", "origin", "created_by")
	SELECT NEW."id", p."data_class_id", p."source", p."origin", p."created_by"
	FROM "thread_data_class" p
	WHERE p."thread_id" = NEW."parent_thread_id"
	ON CONFLICT DO NOTHING;
	INSERT INTO "thread_connector_use" ("thread_id", "connector_id", "first_used_at")
	SELECT NEW."id", p."connector_id", p."first_used_at"
	FROM "thread_connector_use" p
	WHERE p."thread_id" = NEW."parent_thread_id"
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "thread_copy_parent_classes" ON "thread";
--> statement-breakpoint
CREATE TRIGGER "thread_copy_parent_classes" AFTER INSERT ON "thread"
	FOR EACH ROW WHEN (NEW."parent_thread_id" IS NOT NULL)
	EXECUTE FUNCTION "thread_copy_parent_classes"();

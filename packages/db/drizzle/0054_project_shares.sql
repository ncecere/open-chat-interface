-- Project sharing (v0.14, #394): a project shared with a person or a group as a
-- viewer or an editor. One new table and nothing else: no ALTER of an existing
-- table, no backfill, no post-deploy step. The previous release neither reads nor
-- writes it and works unchanged on this schema: every one of its project queries
-- is scoped to the owner, so a share is invisible to it (it can never expose more
-- than the owner's own data).
-- * Every foreign key is ON DELETE CASCADE (SET NULL for "created by"), never
--   RESTRICT, so a previous-release replica deleting a project or an account is
--   never blocked by rows it cannot see; deleting the project removes its shares.
-- * Exactly one subject: a person or a group, enforced by a check, with a partial
--   unique index for each so a subject appears once per project.
-- * Access is computed per request from `project`, `project_share` and
--   `group_member` (0053); nothing is copied onto threads or files.
-- * Hand-written: the Drizzle snapshots stopped at 0042 (the journal is
--   authoritative). The journal `idx` is the entry's position; the tag number
--   only names the file.
--
-- The table is new and empty, so its indexes build instantly inside the
-- migration transaction; the foreign-key validation touches empty rows only.
--
-- Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "project_share" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"project_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_user_id" text,
	"subject_group_id" text,
	"permission" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_subject_type" CHECK ("subject_type" IN ('person', 'group')),
	CONSTRAINT "project_share_permission" CHECK ("permission" IN ('viewer', 'editor')),
	CONSTRAINT "project_share_one_subject" CHECK (
		("subject_type" = 'person' AND "subject_user_id" IS NOT NULL AND "subject_group_id" IS NULL)
		OR ("subject_type" = 'group' AND "subject_group_id" IS NOT NULL AND "subject_user_id" IS NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_share" ADD CONSTRAINT "project_share_project_id_project_id_fk"
		FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_share" ADD CONSTRAINT "project_share_subject_user_id_user_id_fk"
		FOREIGN KEY ("subject_user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_share" ADD CONSTRAINT "project_share_subject_group_id_group_id_fk"
		FOREIGN KEY ("subject_group_id") REFERENCES "group"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "project_share" ADD CONSTRAINT "project_share_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_share_person_unique" ON "project_share" ("project_id", "subject_user_id") WHERE "subject_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_share_group_unique" ON "project_share" ("project_id", "subject_group_id") WHERE "subject_group_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_share_subject_user_idx" ON "project_share" ("subject_user_id") WHERE "subject_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_share_subject_group_idx" ON "project_share" ("subject_group_id") WHERE "subject_group_id" IS NOT NULL;

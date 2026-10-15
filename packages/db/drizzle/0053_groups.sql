-- Groups (v0.14, #394): a department's own budgets and model access, and people
-- who may manage who belongs. A group only ADDS: a person's role stays what
-- decides what they may do, and a group never takes an access away.
--
-- Four new tables and nothing else: no ALTER of an existing table, no backfill,
-- no post-deploy step. The previous release neither reads nor writes them and
-- works unchanged on this schema.
-- * Every foreign key is ON DELETE CASCADE (SET NULL for "created by"), never
--   RESTRICT, so a previous-release replica deleting a user, model or budget is
--   never blocked by rows it cannot see.
-- * `group` is a reserved word in PostgreSQL: every statement quotes it.
-- * Hand-written: the Drizzle snapshots stopped at 0042 (the journal is
--   authoritative). The journal `idx` is the entry's position; the tag number
--   only names the file.
--
-- Migrations run inside one transaction: the tables are new and empty, so the
-- indexes build instantly and nothing existing is rewritten or locked beyond the
-- foreign-key validation of empty tables.
--
-- Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "group" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "group_description_length" CHECK ("description" IS NULL OR char_length("description") <= 300)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "group" ADD CONSTRAINT "group_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "group" ADD CONSTRAINT "group_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_name_unique" ON "group" ("organization_id", lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_member" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_member_pk" PRIMARY KEY ("group_id", "user_id"),
	CONSTRAINT "group_member_role" CHECK ("role" IN ('member', 'manager'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_id_group_id_fk"
		FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "group_member" ADD CONSTRAINT "group_member_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "group_member" ADD CONSTRAINT "group_member_added_by_user_id_user_id_fk"
		FOREIGN KEY ("added_by_user_id") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_member_user_idx" ON "group_member" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quota_policy_group" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"policy_id" text NOT NULL,
	"group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quota_policy_group" ADD CONSTRAINT "quota_policy_group_policy_id_quota_policy_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "quota_policy"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "quota_policy_group" ADD CONSTRAINT "quota_policy_group_group_id_group_id_fk"
		FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quota_policy_group_unique" ON "quota_policy_group" ("policy_id", "group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_policy_group_group_idx" ON "quota_policy_group" ("group_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_group_access" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"model_id" text NOT NULL,
	"group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_group_access" ADD CONSTRAINT "model_group_access_model_id_model_id_fk"
		FOREIGN KEY ("model_id") REFERENCES "model"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "model_group_access" ADD CONSTRAINT "model_group_access_group_id_group_id_fk"
		FOREIGN KEY ("group_id") REFERENCES "group"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_group_access_unique" ON "model_group_access" ("model_id", "group_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_group_access_group_idx" ON "model_group_access" ("group_id");

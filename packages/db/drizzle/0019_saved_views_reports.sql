-- Saved list filters, held per person rather than per instance: "accounts I
-- still have to review" is a working note, not configuration.
CREATE TABLE IF NOT EXISTS "saved_view" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"surface" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
	ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "saved_view_user_surface_idx" ON "saved_view" ("user_id","surface");
CREATE UNIQUE INDEX IF NOT EXISTS "saved_view_user_surface_name_unique" ON "saved_view" ("user_id","surface","name");

-- Usage reports delivered on a schedule. Sent by email because somebody who
-- wants a monthly figure will not remember to open a page for it.
CREATE TABLE IF NOT EXISTS "scheduled_report" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'usage' NOT NULL,
	"cadence" text NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "scheduled_report" ADD CONSTRAINT "scheduled_report_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "scheduled_report_enabled_idx" ON "scheduled_report" ("enabled","last_run_at");

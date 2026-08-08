CREATE TABLE IF NOT EXISTS "usage_policy" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "usage_policy_acceptance" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"policy_id" text NOT NULL,
	"user_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "usage_policy" ADD CONSTRAINT "usage_policy_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "usage_policy" ADD CONSTRAINT "usage_policy_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- restrict, not cascade: deleting a policy version that somebody accepted
-- would destroy the record of what they agreed to.
DO $$ BEGIN
	ALTER TABLE "usage_policy_acceptance" ADD CONSTRAINT "usage_policy_acceptance_policy_id_usage_policy_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "public"."usage_policy"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "usage_policy_acceptance" ADD CONSTRAINT "usage_policy_acceptance_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

ALTER TABLE "user_preference" ADD COLUMN IF NOT EXISTS "onboarded_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "usage_policy_org_version_unique" ON "usage_policy" USING btree ("organization_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_policy_published_idx" ON "usage_policy" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_policy_acceptance_unique" ON "usage_policy_acceptance" USING btree ("policy_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_policy_acceptance_user_idx" ON "usage_policy_acceptance" USING btree ("user_id");

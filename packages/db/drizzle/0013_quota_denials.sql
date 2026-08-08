CREATE TABLE IF NOT EXISTS "quota_denial" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"policy_id" text,
	"policy_name" text NOT NULL,
	"model_slug" text NOT NULL,
	"day" text NOT NULL,
	"denial_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_denial" ADD CONSTRAINT "quota_denial_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_denial" ADD CONSTRAINT "quota_denial_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- No foreign key to quota_policy on purpose: the snapshotted name has to
-- outlive the policy, so a deleted limit still explains the denials it caused.
CREATE UNIQUE INDEX IF NOT EXISTS "quota_denial_unique" ON "quota_denial" USING btree ("user_id","policy_id","model_slug","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_denial_day_idx" ON "quota_denial" USING btree ("day");

CREATE TABLE IF NOT EXISTS "quota_policy_override" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"policy_id" text NOT NULL,
	"user_id" text NOT NULL,
	"limit_value" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_policy_override" ADD CONSTRAINT "quota_policy_override_policy_id_quota_policy_id_fk"
		FOREIGN KEY ("policy_id") REFERENCES "public"."quota_policy"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_policy_override" ADD CONSTRAINT "quota_policy_override_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "quota_policy_override" ADD CONSTRAINT "quota_policy_override_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- One override per policy per person: editing replaces rather than accumulates,
-- so a user's effective limit always has exactly one source.
CREATE UNIQUE INDEX IF NOT EXISTS "quota_policy_override_unique" ON "quota_policy_override" USING btree ("policy_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_policy_override_user_idx" ON "quota_policy_override" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_policy_override_expiry_idx" ON "quota_policy_override" USING btree ("expires_at");

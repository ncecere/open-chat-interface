-- Two-step verification for local accounts (#399, v0.14). Better Auth's
-- `twoFactor` plugin keeps one row per person who set up an authenticator:
-- the TOTP secret and the recovery codes, both encrypted by the plugin with
-- AUTH_SECRET (not ENCRYPTION_KEY, deliberately: docs/dev/database.md,
-- "Encrypted secrets"), and the failure count and lock of the second step.
-- `user.two_factor_enabled` is the plugin's flag, true once a code was confirmed.
--
-- Pre-deploy safe: a v0.13 replica names its columns, so it ignores the new
-- table and column; its sign-ups get the default (false) and it challenges
-- nobody (it has no plugin), which the upgrade note covers: enrol after the roll.
-- * `two_factor` is new and empty. The unique index on `user_id` is there
--   because the plugin deletes a person's row and inserts a new one without a
--   transaction: a race then fails instead of leaving two rows. The plugin's
--   generated index on `secret` is not made: nothing queries by it.
-- * `two_factor_enabled` has a constant default, a catalog-only change with no
--   table rewrite (a brief ACCESS EXCLUSIVE lock on "user").
--
-- Re-runnable: every statement is guarded.
CREATE TABLE IF NOT EXISTS "two_factor" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "two_factor_user_id_unique" ON "two_factor" ("user_id");
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean DEFAULT false NOT NULL;

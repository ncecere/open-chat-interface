-- How a session was created, and passkeys (#399, v0.14).
--
-- `session.auth_method` records the way in (password, totp, recovery_code,
-- passkey, sso, other), set by OCI when the session is created. Better Auth
-- records nothing of the kind, and the per-role requirement has to tell a
-- password-only session from one that passed a second step, a passkey or
-- single sign-on. NULL (every session that exists today, and any created by a
-- v0.13 replica) reads as `password`.
--
-- `passkey` is the table of @better-auth/passkey: one row per registered
-- credential (the public key, the signature counter, what kind of device it
-- is), never the private key, which stays in the authenticator.
--
-- Pre-deploy safe: a v0.13 replica names its columns, so it ignores both.
-- * `auth_method` is nullable without a default: a catalog-only change.
-- * `passkey` is new and empty; its indexes are built in this migration.
--   `counter` is bigint because WebAuthn counters are unsigned 32-bit.
--
-- Re-runnable: every statement is guarded.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "auth_method" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkey" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" bigint NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aaguid" text
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credential_id_unique" ON "passkey" ("credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_user_idx" ON "passkey" ("user_id");

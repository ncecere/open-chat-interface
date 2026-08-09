-- Per-provider authorisation and profile-claim controls.
--
-- require_role_match defaults to false so an existing provider keeps its
-- current behaviour on upgrade: turning it on is a deliberate decision to make
-- group mapping an authorisation boundary rather than a label.
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "require_role_match" boolean NOT NULL DEFAULT false;
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "role_required_message" text;
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "claim_mappings" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "sso_provider" ADD COLUMN IF NOT EXISTS "auto_redirect" boolean NOT NULL DEFAULT false;

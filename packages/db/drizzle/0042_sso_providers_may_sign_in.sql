-- Better Auth's SSO plugin refuses every sign-in from a provider whose
-- domain_verified is false. OCI used that column for "trust for account
-- linking", so a provider with linking off (the default) could not sign anyone
-- in. Linking is now enforced by OCI's own account hook from
-- trusted_for_linking, and domain_verified only means the provider may sign
-- people in: true for every provider.
-- oci:lint-allow data-change: sso_provider holds one row per configured identity provider, a handful at most
UPDATE "sso_provider" SET "domain_verified" = true WHERE "domain_verified" = false;

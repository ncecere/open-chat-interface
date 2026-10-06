-- An account's audit trail also lists what was done anonymously with its
-- address: a password-reset request or a refused sign-in has no signed-in
-- actor, so it carries only `actor_email` (#342). The trail matches it on
-- `lower(actor_email)` where `actor_user_id` is null; this partial index
-- answers that without scanning the log. Small: only entries made without a
-- signed-in actor are in it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_actor_email_idx" ON "audit_log" (lower("actor_email")) WHERE "actor_user_id" IS NULL;

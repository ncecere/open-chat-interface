-- A scheduled report whose email failed is tried again (#352). `last_run_at`
-- is now only a successful send: before, a failed attempt wrote it too, so
-- the report counted as sent for its whole period and nothing tried again.
-- `last_attempt_at` is when the last failed attempt was made and
-- `failed_attempts` how many failed since the last success, which the hourly
-- check uses to retry after a growing pause, a few times, and then once a
-- period (apps/api/src/services/reports.ts).
--
-- Pre-deploy safe: the previous release neither writes nor reads the new
-- columns and works unchanged on this schema (it still records a failed send
-- in `last_run_at`, as before).
-- * `last_attempt_at` is nullable without a default, and `failed_attempts` has
--   a constant default: both are catalog-only changes, with no table rewrite.
--
-- Re-runnable: every statement is guarded.
ALTER TABLE "scheduled_report" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_report" ADD COLUMN IF NOT EXISTS "failed_attempts" integer DEFAULT 0 NOT NULL;

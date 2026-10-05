-- The usage page counts failed replies per model since a date. With only
-- `message_created_at_idx` that reads every message of the period from the
-- heap to find the few that failed (on the scale harness's `small` dataset,
-- slower than the sequential scan it replaced); a partial index over failed
-- replies alone answers it from a few pages. Small: only `error` rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_error_created_at_idx" ON "message" ("created_at") WHERE "status" = 'error';

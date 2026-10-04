-- The usage page's Overview tab counts cancelled replies since a date, as it
-- counts failed ones with `message_error_created_at_idx`. Small: only
-- `cancelled` rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_cancelled_created_at_idx" ON "message" ("created_at") WHERE "status" = 'cancelled';

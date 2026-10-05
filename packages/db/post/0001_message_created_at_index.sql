-- The admin overview counts messages per day for the last fortnight and in the
-- last 24 and 48 hours, and the usage page counts failed replies since a date.
-- Without an index on `message.created_at` each count is a sequential scan of
-- the whole table (docs/dev/scale-harness.md, finding 4). Built CONCURRENTLY:
-- writes to `message` continue while it builds. If a build is interrupted it
-- leaves an INVALID index, which the next `migrate --post` drops and rebuilds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_created_at_idx" ON "message" ("created_at");

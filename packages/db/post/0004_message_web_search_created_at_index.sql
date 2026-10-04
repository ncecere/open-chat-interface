-- The usage page's Overview tab counts replies that searched the web since a
-- date: a partial index over those replies alone, read index-only. Small.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_web_search_created_at_idx" ON "message" ("created_at") WHERE "web_search_used";

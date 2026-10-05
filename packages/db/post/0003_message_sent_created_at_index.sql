-- The usage page's Overview tab counts the messages people sent (role 'user')
-- since a date. With only `message_created_at_idx` that reads every message of
-- the period from the heap (522 ms over 30 days at the scale harness's
-- `medium`); this partial index answers it with an index-only scan of the
-- sent messages alone. About half the size of `message_created_at_idx`.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_sent_created_at_idx" ON "message" ("created_at") WHERE "role" = 'user';

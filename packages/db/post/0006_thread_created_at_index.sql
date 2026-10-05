-- Conversations created since a date: the usage page's Overview tab (with how
-- many were temporary or branches) and the admin overview's last 24 and 48
-- hours. Both scanned the whole table. The included columns let the Overview
-- tab's counts run as an index-only scan; `parent_thread_id` is null except
-- on branches, so it adds almost nothing to the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "thread_created_at_idx" ON "thread" ("created_at") INCLUDE ("temporary", "parent_thread_id");

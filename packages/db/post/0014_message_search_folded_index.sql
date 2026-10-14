-- Accent-insensitive search of message text (#362, SPEC-accent-search.md): the
-- index over message.search_folded (migration 0048). Partial, because most
-- messages have nothing to fold and keep it NULL: the index holds only the
-- messages whose text has accented letters, a small fraction of the table.
-- Search matches the exact-text index OR this one, and uses this one only once
-- it is built and the background migration 0.13.message-search-folded has
-- filled the column.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_search_folded_idx" ON "message" USING gin ("search_folded") WHERE "search_folded" IS NOT NULL;

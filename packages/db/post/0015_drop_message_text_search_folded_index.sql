-- v0.12.0 and v0.12.1 let an operator build an optional index over the folded
-- message text by hand (message_text_search_folded_idx, #362). v0.13 stores a
-- folded vector per message instead (message.search_folded, migration 0048,
-- indexed by step 0014) and never reads that index, so one an operator built is
-- dropped now, once no replica of the previous release can use it. Most
-- instances never built it, and `IF EXISTS` makes this a no-op for them.
DROP INDEX CONCURRENTLY IF EXISTS "message_text_search_folded_idx";

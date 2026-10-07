-- Which attachment rows use a stored object (#358). A fork and an edit have
-- rows of their own for a file they share with their source, pointing at the
-- same object, so the delete trigger (migration 0045), the storage reaper and
-- the purge paths ask "is another row still using this object?" by its key.
-- Until this step has run the question is answered by scanning the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attachment_storage_key_idx" ON "attachment" ("storage_key");

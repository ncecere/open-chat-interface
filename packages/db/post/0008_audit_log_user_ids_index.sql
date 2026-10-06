-- Bulk account actions (`user.bulk.*`) name the accounts they changed in
-- `metadata.userIds` rather than `target_id` (#216). A GIN index on that
-- array answers "which entries name this account?" (`metadata -> 'userIds' ?
-- id`) without scanning the log. Small: only bulk entries carry the key.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_user_ids_idx" ON "audit_log" USING gin (("metadata" -> 'userIds'));

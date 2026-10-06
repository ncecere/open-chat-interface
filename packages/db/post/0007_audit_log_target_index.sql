-- An account's audit trail (its page's Recent activity, and the audit log
-- filtered to "Events by or about" it) matches entries by actor, by target,
-- or by the accounts a bulk action named (#216). Without an index on
-- `target_id` the OR of the three scanned the whole audit log, the table that
-- grows fastest after messages. With this one and 0008, PostgreSQL combines
-- three index scans instead.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_target_idx" ON "audit_log" ("target_id");

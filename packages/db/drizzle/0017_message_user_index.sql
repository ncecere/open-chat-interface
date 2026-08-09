-- The admin user listing counts messages per user with a correlated subquery,
-- so an unindexed message.user_id scans every message once per user row.
-- Measured at 20,000 users and 2,000,000 messages: the default listing fell
-- from 2,553 ms to 5 ms, and sorting by message count from over 60 s to 147 ms.
CREATE INDEX IF NOT EXISTS "message_user_idx" ON "message" ("user_id");

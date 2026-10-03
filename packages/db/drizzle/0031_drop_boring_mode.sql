-- Second step of removing `user_preference.boring_mode` (v0.9). v0.8 stopped
-- reading and writing the column and removed it from the Drizzle schema, so a
-- v0.8 replica still running while this migration applies never names it. See
-- docs/dev/database.md, "Removing a column".
--
-- Dropping a column is a catalog change in PostgreSQL: it does not rewrite the
-- table, but it takes a brief ACCESS EXCLUSIVE lock on `user_preference`.
-- Re-runnable: IF EXISTS makes a second application a no-op.
ALTER TABLE "user_preference" DROP COLUMN IF EXISTS "boring_mode";

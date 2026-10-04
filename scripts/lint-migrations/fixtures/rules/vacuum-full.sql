-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
VACUUM FULL "t";
-- fixture: good
ANALYZE "t";
-- fixture: allowed
-- oci:lint-allow vacuum-full: illustrative only; the migrator would reject it anyway
VACUUM (FULL) "t";
-- fixture: missing-reason
-- oci:lint-allow vacuum-full
VACUUM FULL "t";

-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
CLUSTER "t" USING "t_pkey";
-- fixture: good
ANALYZE "t";
-- fixture: allowed
-- oci:lint-allow cluster: t is a lookup table of a few rows
CLUSTER "t" USING "t_pkey";
-- fixture: missing-reason
-- oci:lint-allow cluster
CLUSTER "t" USING "t_pkey";

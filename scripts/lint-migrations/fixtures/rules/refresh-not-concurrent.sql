-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
--> statement-breakpoint
CREATE MATERIALIZED VIEW "t_summary" AS SELECT "a", count(*) AS "n" FROM "t" GROUP BY "a";
-- fixture: bad
REFRESH MATERIALIZED VIEW "t_summary";
-- fixture: good
REFRESH MATERIALIZED VIEW CONCURRENTLY "t_summary";
-- fixture: allowed
-- oci:lint-allow refresh-not-concurrent: the view has no unique index yet and is small
REFRESH MATERIALIZED VIEW "t_summary";
-- fixture: missing-reason
-- oci:lint-allow refresh-not-concurrent
REFRESH MATERIALIZED VIEW "t_summary";

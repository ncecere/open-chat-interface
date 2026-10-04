-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
DO $$ BEGIN
	EXECUTE format('ALTER TABLE %I ADD COLUMN b text', 't');
END $$;
-- fixture: good
DO $$ BEGIN
	ALTER TABLE "t" ADD CONSTRAINT "t_u_id_fk" FOREIGN KEY ("u_id") REFERENCES "u"("id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- fixture: allowed
-- oci:lint-allow dynamic-sql: adds one nullable column to a fixed table
DO $$ BEGIN
	EXECUTE format('ALTER TABLE %I ADD COLUMN b text', 't');
END $$;
-- fixture: missing-reason
-- oci:lint-allow dynamic-sql
DO $$ BEGIN
	EXECUTE format('ALTER TABLE %I ADD COLUMN b text', 't');
END $$;

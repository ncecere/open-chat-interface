-- fixture-phase: post
-- fixture: setup
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text);
--> statement-breakpoint
ALTER TABLE "t" ADD CONSTRAINT "t_a_check" CHECK ("a" <> '') NOT VALID;
-- fixture: bad
DO $$ BEGIN
	ALTER TABLE "t" VALIDATE CONSTRAINT "t_a_check";
END $$;
-- fixture: good
ALTER TABLE "t" VALIDATE CONSTRAINT "t_a_check";
-- fixture: allowed
-- oci:lint-allow post-transaction: validates one constraint; the block only names it
DO $$ BEGIN
	ALTER TABLE "t" VALIDATE CONSTRAINT "t_a_check";
END $$;
-- fixture: missing-reason
-- oci:lint-allow post-transaction
DO $$ BEGIN
	ALTER TABLE "t" VALIDATE CONSTRAINT "t_a_check";
END $$;

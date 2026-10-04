-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" ADD CONSTRAINT "t_u_id_fk" FOREIGN KEY ("u_id") REFERENCES "u"("id") ON DELETE cascade;
-- fixture: good
ALTER TABLE "t" ADD CONSTRAINT "t_u_id_fk" FOREIGN KEY ("u_id") REFERENCES "u"("id") ON DELETE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "t" ADD CONSTRAINT "t_a_length" CHECK (char_length("a") <= 100) NOT VALID;
-- fixture: allowed
-- oci:lint-allow constraint-not-valid: u_id was added in this release and is always null
ALTER TABLE "t" ADD CONSTRAINT "t_u_id_fk" FOREIGN KEY ("u_id") REFERENCES "u"("id");
-- fixture: missing-reason
-- oci:lint-allow constraint-not-valid
ALTER TABLE "t" ADD CONSTRAINT "t_u_id_fk" FOREIGN KEY ("u_id") REFERENCES "u"("id");

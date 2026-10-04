-- fixture: setup
CREATE TABLE "u" ("id" text PRIMARY KEY);
--> statement-breakpoint
CREATE TABLE "t" ("id" text PRIMARY KEY, "a" text, "u_id" text);
-- fixture: bad
ALTER TABLE "t" ADD COLUMN "token" uuid DEFAULT gen_random_uuid() NOT NULL;
-- fixture: good
ALTER TABLE "t" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "n" ("id" text PRIMARY KEY);
--> statement-breakpoint
ALTER TABLE "n" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
-- fixture: allowed
-- oci:lint-allow volatile-default: now() is stable (no rewrite); existing rows may share the upgrade time
ALTER TABLE "t" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
-- fixture: missing-reason
-- oci:lint-allow volatile-default
ALTER TABLE "t" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;

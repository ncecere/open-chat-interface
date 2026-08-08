CREATE TABLE IF NOT EXISTS "broadcast" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"audience_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dismissable" boolean DEFAULT true NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "broadcast_dismissal" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"broadcast_id" text NOT NULL,
	"user_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_created_by_user_id_user_id_fk"
		FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- A dismissal belongs to the announcement it hides, so removing the
-- announcement removes the record of who hid it.
DO $$ BEGIN
	ALTER TABLE "broadcast_dismissal" ADD CONSTRAINT "broadcast_dismissal_broadcast_id_broadcast_id_fk"
		FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcast"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "broadcast_dismissal" ADD CONSTRAINT "broadcast_dismissal_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "broadcast_active_idx" ON "broadcast" USING btree ("published","starts_at","ends_at");--> statement-breakpoint
-- One dismissal per person per announcement; dismissing twice is not an error.
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_dismissal_unique" ON "broadcast_dismissal" USING btree ("broadcast_id","user_id");

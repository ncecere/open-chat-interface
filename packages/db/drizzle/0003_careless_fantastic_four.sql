CREATE TABLE "quota_policy" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"metric" text NOT NULL,
	"limit_value" bigint NOT NULL,
	"window_kind" text DEFAULT 'rolling' NOT NULL,
	"window_hours" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_policy_role" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"policy_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"model_slug" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 1 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"input_price_micros" bigint,
	"output_price_micros" bigint
);
--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "input_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "output_price_micros" bigint;--> statement-breakpoint
ALTER TABLE "usage_record" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_policy" ADD CONSTRAINT "quota_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_policy_role" ADD CONSTRAINT "quota_policy_role_policy_id_quota_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."quota_policy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_policy_org_name_unique" ON "quota_policy" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "quota_policy_org_idx" ON "quota_policy" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_policy_role_unique" ON "quota_policy_role" USING btree ("policy_id","role");--> statement-breakpoint
CREATE INDEX "quota_policy_role_role_idx" ON "quota_policy_role" USING btree ("role");--> statement-breakpoint
CREATE INDEX "usage_event_user_occurred_idx" ON "usage_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
-- The rollup previously had no unique constraint, so concurrent streams could
-- race into duplicate rows. Fold any duplicates together before enforcing it.
WITH ranked AS (
	SELECT "id", "user_id", "model_slug", "day",
		row_number() OVER (PARTITION BY "user_id", "model_slug", "day" ORDER BY "created_at") AS position
	FROM "usage_record"
), totals AS (
	SELECT "user_id", "model_slug", "day",
		sum("message_count") AS message_count,
		sum("tokens_in") AS tokens_in,
		sum("tokens_out") AS tokens_out
	FROM "usage_record"
	GROUP BY "user_id", "model_slug", "day"
)
UPDATE "usage_record" AS target
SET "message_count" = totals.message_count,
	"tokens_in" = totals.tokens_in,
	"tokens_out" = totals.tokens_out
FROM ranked, totals
WHERE target."id" = ranked."id"
	AND ranked.position = 1
	AND totals."user_id" = ranked."user_id"
	AND totals."model_slug" = ranked."model_slug"
	AND totals."day" = ranked."day";--> statement-breakpoint
DELETE FROM "usage_record" WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (PARTITION BY "user_id", "model_slug", "day" ORDER BY "created_at") AS position
		FROM "usage_record"
	) duplicates WHERE duplicates.position > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "usage_record_user_model_day_unique" ON "usage_record" USING btree ("user_id","model_slug","day");
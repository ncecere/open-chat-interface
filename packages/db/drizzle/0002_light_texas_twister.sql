ALTER TABLE "thread" ADD COLUMN "temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
WITH ranked_defaults AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id"
    ORDER BY "updated_at" DESC, "id" DESC
  ) AS "row_number"
  FROM "persona"
  WHERE "is_default" = true
)
UPDATE "persona"
SET "is_default" = false
WHERE "id" IN (
  SELECT "id" FROM ranked_defaults WHERE "row_number" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "persona_user_default_unique" ON "persona" USING btree ("user_id") WHERE "persona"."is_default";--> statement-breakpoint
CREATE INDEX "thread_temporary_expiry_idx" ON "thread" USING btree ("temporary","expires_at");
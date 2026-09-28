-- Existing settled rows cannot reliably be classified as measured vs. swept;
-- preserve them. New unknown settlements are explicitly amendable by late usage.
ALTER TABLE "usage_event" ADD COLUMN "usage_unknown" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- A daily aggregate can exceed int32 even when each individual report fits.
ALTER TABLE "usage_record" ALTER COLUMN "tokens_in" TYPE bigint;
--> statement-breakpoint
ALTER TABLE "usage_record" ALTER COLUMN "tokens_out" TYPE bigint;

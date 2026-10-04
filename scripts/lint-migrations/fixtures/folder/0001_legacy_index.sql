-- Predates the linter: grandfathered by baseline.json in this folder.
CREATE INDEX "message_body_idx" ON "message" ("body");
--> statement-breakpoint
UPDATE "message" SET "body" = '' WHERE "body" IS NULL;

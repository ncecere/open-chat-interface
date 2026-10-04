CREATE TABLE "message" ("id" text PRIMARY KEY, "thread_id" text NOT NULL, "body" text);
--> statement-breakpoint
CREATE INDEX "message_thread_id_idx" ON "message" ("thread_id");

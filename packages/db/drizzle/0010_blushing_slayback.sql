ALTER TABLE "thread" DROP CONSTRAINT "thread_persona_id_persona_id_fk";--> statement-breakpoint
ALTER TABLE "thread" DROP COLUMN "persona_id";--> statement-breakpoint
ALTER TABLE "persona" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "persona" CASCADE;

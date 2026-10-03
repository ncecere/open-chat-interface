-- Compliance export and legal hold (v0.9). See docs/dev/v0.9-design.md,
-- "Compliance export and legal hold", and docs/admin/compliance.md.
--
-- The export continues from a cursor, so it needs an order in which no row can
-- appear behind the cursor after the cursor has passed it:
--
-- * `audit_log.seq`: a sequence number for every audit entry. Existing entries
--   are numbered once, in (created_at, id) order, under the exclusive lock this
--   migration's ALTER TABLE takes, so nothing is inserted while they are.
-- * `message.change_seq`: set from a sequence by a trigger when a message is
--   inserted and whenever its parts, status, error or superseded time change.
--   Existing messages keep NULL: content export starts when it is turned on.
--
-- A sequence alone is not enough (a transaction can draw a number and commit
-- after a later one); the exporter reads its upper bound under a brief SHARE
-- lock, which waits for every transaction already writing to the table.
--
-- `legal_hold` names people whose data retention, trash purging, temporary
-- chat expiry and account deletion must skip. A trigger refuses to delete an
-- account while it is held, whichever code path tries.
--
-- `compliance_export_run` is the run history and `compliance_export_cursor`
-- the position of each stream ('audit', 'messages').
--
-- Re-runnable: every statement is guarded, so applying it twice is harmless.
CREATE SEQUENCE IF NOT EXISTS "audit_log_seq_seq" AS bigint;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "seq" bigint;
--> statement-breakpoint
UPDATE "audit_log" AS "a"
SET "seq" = "o"."n" + COALESCE((SELECT max("seq") FROM "audit_log"), 0)
FROM (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "n"
	FROM "audit_log"
	WHERE "seq" IS NULL
) AS "o"
WHERE "a"."id" = "o"."id";
--> statement-breakpoint
SELECT setval(
	'audit_log_seq_seq',
	GREATEST(COALESCE((SELECT max("seq") FROM "audit_log"), 0), (SELECT "last_value" FROM "audit_log_seq_seq")),
	true
);
--> statement-breakpoint
ALTER SEQUENCE "audit_log_seq_seq" OWNED BY "audit_log"."seq";
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "seq" SET DEFAULT nextval('audit_log_seq_seq');
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "seq" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_log_seq_unique" ON "audit_log" ("seq");
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "message_change_seq" AS bigint;
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "change_seq" bigint;
--> statement-breakpoint
-- The columns are compared in the function rather than in a trigger WHEN
-- clause, which would make them undroppable without dropping the trigger.
CREATE OR REPLACE FUNCTION "message_bump_change_seq"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW."change_seq" := nextval('message_change_seq');
	ELSIF OLD."parts" IS DISTINCT FROM NEW."parts"
		OR OLD."status" IS DISTINCT FROM NEW."status"
		OR OLD."error_message" IS DISTINCT FROM NEW."error_message"
		OR OLD."superseded_at" IS DISTINCT FROM NEW."superseded_at" THEN
		NEW."change_seq" := nextval('message_change_seq');
	END IF;
	RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "message_change_seq" ON "message";
--> statement-breakpoint
CREATE TRIGGER "message_change_seq" BEFORE INSERT OR UPDATE ON "message"
	FOR EACH ROW EXECUTE FUNCTION "message_bump_change_seq"();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_change_seq_idx" ON "message" ("change_seq")
	WHERE "change_seq" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "legal_hold" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text NOT NULL,
	"reason" text NOT NULL,
	"placed_by_user_id" text,
	"placed_by_email" text,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_user_id" text,
	"lifted_by_email" text,
	"lift_reason" text,
	CONSTRAINT "legal_hold_reason_length" CHECK (char_length("reason") between 1 and 1000),
	CONSTRAINT "legal_hold_lift_reason_length" CHECK ("lift_reason" is null or char_length("lift_reason") <= 1000)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_placed_by_user_id_user_id_fk"
		FOREIGN KEY ("placed_by_user_id") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_lifted_by_user_id_user_id_fk"
		FOREIGN KEY ("lifted_by_user_id") REFERENCES "user"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legal_hold_active_unique" ON "legal_hold" ("user_id")
	WHERE "lifted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legal_hold_placed_idx" ON "legal_hold" ("placed_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "legal_hold_guard_user_delete"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "legal_hold" WHERE "user_id" = OLD."id" AND "lifted_at" IS NULL
	) THEN
		RAISE EXCEPTION 'This person is on legal hold. Lift the hold before deleting the account.'
			USING ERRCODE = 'OCLH1';
	END IF;
	RETURN OLD;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "legal_hold_guard_user_delete" ON "user";
--> statement-breakpoint
CREATE TRIGGER "legal_hold_guard_user_delete" BEFORE DELETE ON "user"
	FOR EACH ROW EXECUTE FUNCTION "legal_hold_guard_user_delete"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_export_cursor" (
	"stream" text PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_run_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_export_cursor_stream" CHECK ("stream" in ('audit', 'messages'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compliance_export_run" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"destination" text NOT NULL,
	"key_prefix" text NOT NULL,
	"include_content" boolean DEFAULT false NOT NULL,
	"audit_key" text,
	"audit_after_seq" bigint,
	"audit_through_seq" bigint,
	"audit_count" integer,
	"audit_first_id" text,
	"audit_last_id" text,
	"audit_bytes" bigint,
	"audit_sha256" text,
	"messages_key" text,
	"messages_after_seq" bigint,
	"messages_through_seq" bigint,
	"message_count" integer,
	"messages_first_id" text,
	"messages_last_id" text,
	"messages_bytes" bigint,
	"messages_sha256" text,
	"manifest_key" text,
	"manifest_sha256" text,
	"verified" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"cleanup_pending" boolean DEFAULT false NOT NULL,
	"pruned_at" timestamp with time zone,
	CONSTRAINT "compliance_export_run_trigger" CHECK ("trigger" in ('schedule', 'manual')),
	CONSTRAINT "compliance_export_run_status" CHECK ("status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "compliance_export_run" ADD CONSTRAINT "compliance_export_run_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_export_run_started_idx" ON "compliance_export_run" ("started_at");

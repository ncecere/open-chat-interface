-- Retried replies: a user turn may have several stored assistant replies, of
-- which exactly one is active. The others carry `superseded_at` and are left
-- out of model context, exports, share links and search, but are kept so the
-- person can switch back to them (only on the latest turn).
--
-- Nullable without a default, so adding the column does not rewrite the table.
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: before this migration a retry appended a second reply to the same
-- turn and every reply was sent to the model on the next turn. Keep the newest
-- reply of each turn active (the one people saw after retrying) and supersede
-- the rest. A turn is every assistant row after a user row, up to the next user
-- row, in position order. Assistant rows before any user row are left alone.
-- One pass over `message` with a sort; migrations run inside one transaction.
WITH ordered AS (
	SELECT
		"id",
		"thread_id",
		"role",
		"position",
		"created_at",
		count(*) FILTER (WHERE "role" = 'user') OVER (
			PARTITION BY "thread_id"
			ORDER BY "position", "created_at", "id"
			ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
		) AS "turn"
	FROM "message"
	WHERE "role" IN ('user', 'assistant')
),
ranked AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "thread_id", "turn"
			ORDER BY "position" DESC, "created_at" DESC, "id" DESC
		) AS "rank"
	FROM ordered
	WHERE "role" = 'assistant' AND "turn" > 0
)
UPDATE "message"
SET "superseded_at" = now()
FROM ranked
WHERE "message"."id" = ranked."id"
	AND ranked."rank" > 1
	AND "message"."superseded_at" IS NULL;

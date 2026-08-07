-- Converts legacy per-role quotas into named policies. A single role_quota row
-- could carry both a message and a token limit, so each becomes its own policy.
-- Legacy limits were always rolling windows measured in hours.

INSERT INTO "quota_policy" (
	"organization_id", "name", "description", "metric",
	"limit_value", "window_kind", "window_hours", "timezone", "enabled"
)
SELECT
	"organization_id",
	'Migrated ' || "role" || ' messages',
	'Imported from the previous per-role quota settings.',
	'messages',
	"max_messages_per_window",
	'rolling',
	"window_hours",
	'UTC',
	"enabled"
FROM "role_quota"
WHERE "max_messages_per_window" IS NOT NULL
ON CONFLICT ("organization_id", "name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "quota_policy" (
	"organization_id", "name", "description", "metric",
	"limit_value", "window_kind", "window_hours", "timezone", "enabled"
)
SELECT
	"organization_id",
	'Migrated ' || "role" || ' tokens',
	'Imported from the previous per-role quota settings.',
	'tokens',
	"max_tokens_per_window",
	'rolling',
	"window_hours",
	'UTC',
	"enabled"
FROM "role_quota"
WHERE "max_tokens_per_window" IS NOT NULL
ON CONFLICT ("organization_id", "name") DO NOTHING;
--> statement-breakpoint

INSERT INTO "quota_policy_role" ("policy_id", "role")
SELECT policy."id", legacy."role"
FROM "role_quota" AS legacy
JOIN "quota_policy" AS policy
	ON policy."organization_id" = legacy."organization_id"
	AND policy."name" IN (
		'Migrated ' || legacy."role" || ' messages',
		'Migrated ' || legacy."role" || ' tokens'
	)
ON CONFLICT ("policy_id", "role") DO NOTHING;
--> statement-breakpoint

-- Backfill usage events from the daily rollup so existing consumption is not
-- silently forgotten. Each day is anchored to midnight UTC, which is the only
-- instant the legacy `day` column can justify.
INSERT INTO "usage_event" (
	"organization_id", "user_id", "model_slug", "occurred_at",
	"message_count", "tokens_in", "tokens_out", "cost_micros"
)
SELECT
	"organization_id", "user_id", "model_slug", ("day" || 'T00:00:00Z')::timestamptz,
	"message_count", "tokens_in", "tokens_out", 0
FROM "usage_record";

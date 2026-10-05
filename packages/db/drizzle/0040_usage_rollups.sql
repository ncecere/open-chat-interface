-- Usage rollups (v0.11 design, "Further scale work", item 18). See
-- docs/dev/database.md, "Usage rollups".
--
-- Hourly sums of usage events, so the Usage pages, scheduled reports and
-- budget checks read a few rows per hour instead of every event:
--
-- * `usage_rollup_hour`: per UTC hour, person (null for deleted accounts) and
--   model. Budgets, top consumers and the count of active people read it.
-- * `usage_rollup_model_hour`: per UTC hour and model, for instance totals,
--   daily figures and the per-model table.
-- * `usage_rollup_change`: an append-only log of differences. Statement
--   triggers on `usage_event` write one row per (hour, person, model) a
--   statement changed, in the writer's own transaction, so every writer is
--   covered (this release, the previous one during a rolling upgrade,
--   retention, the account-deletion foreign key) without a hot row: nothing
--   here updates a shared row. The job `usage.fold-rollups` folds the log into
--   the two tables. Readers add the unfolded log in the same statement, so
--   what they read is exact whenever they read it.
-- * `usage_event.in_rollup`: true once an event's amounts are in the rollups.
--   A trigger sets it on every insert and update; the background migration
--   `0.11.usage-rollups` sets it on events written before this migration
--   (which the triggers then add). An event without it contributes nothing,
--   so a change to an old event before the backfill reaches it is never
--   counted twice.
--
-- The rollups mirror the events: an event pruned by retention leaves them
-- too, so they hold exactly the usage that is kept, for as long as it is kept
-- (the usage-event retention setting). Nothing in them identifies a person
-- beyond the account id, which becomes null with the event's.
--
-- Additive and pre-deploy safe: a nullable column without a default (no
-- rewrite), three new tables and their indexes, and triggers. The previous
-- release never reads any of it; its writes are captured by the triggers.
ALTER TABLE "usage_event" ADD COLUMN IF NOT EXISTS "in_rollup" boolean;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_rollup_change" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"hour" timestamp with time zone NOT NULL,
	"user_id" text,
	"model_slug" text NOT NULL,
	"events" bigint NOT NULL,
	"settled_events" bigint NOT NULL,
	"messages" bigint NOT NULL,
	"tokens_in" bigint NOT NULL,
	"tokens_out" bigint NOT NULL,
	"cost_micros" bigint NOT NULL,
	"quota_messages" bigint NOT NULL,
	"quota_tokens" bigint NOT NULL,
	"quota_cost_micros" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_rollup_change_hour_idx" ON "usage_rollup_change" ("hour");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_rollup_change_user_idx" ON "usage_rollup_change" ("user_id", "hour");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_rollup_hour" (
	"hour" timestamp with time zone NOT NULL,
	"user_id" text,
	"model_slug" text NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"settled_events" bigint DEFAULT 0 NOT NULL,
	"messages" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"quota_messages" bigint DEFAULT 0 NOT NULL,
	"quota_tokens" bigint DEFAULT 0 NOT NULL,
	"quota_cost_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Deleted accounts share one key per hour and model: NULLS NOT DISTINCT.
CREATE UNIQUE INDEX IF NOT EXISTS "usage_rollup_hour_key" ON "usage_rollup_hour" ("hour", "user_id", "model_slug") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_rollup_hour_user_idx" ON "usage_rollup_hour" ("user_id", "hour");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_rollup_model_hour" (
	"hour" timestamp with time zone NOT NULL,
	"model_slug" text NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"settled_events" bigint DEFAULT 0 NOT NULL,
	"messages" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_rollup_model_hour_pkey" PRIMARY KEY ("hour", "model_slug")
);
--> statement-breakpoint
-- Every write marks the event as counted; the statement triggers below then
-- add it. Unconditional, so an event the backfill has not reached yet is
-- counted in full by its next write instead of by a difference.
CREATE OR REPLACE FUNCTION "usage_event_mark_in_rollup"() RETURNS trigger AS $$
BEGIN
	NEW."in_rollup" := true;
	RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- One function per event kind: each refers to the transition tables its
-- trigger declares. Hours are UTC (three-argument date_trunc), whatever the
-- session's time zone. A row counts once (`events`); `settled_*` is what the
-- reports sum (settled events only), `quota_*` what budgets sum (every
-- event, with the estimates still held for unreported usage).
CREATE OR REPLACE FUNCTION "usage_event_rollup_insert"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "usage_rollup_change" ("hour", "user_id", "model_slug", "events", "settled_events",
		"messages", "tokens_in", "tokens_out", "cost_micros", "quota_messages", "quota_tokens", "quota_cost_micros")
	SELECT date_trunc('hour', n."occurred_at", 'UTC'), n."user_id", n."model_slug",
		count(*),
		count(*) FILTER (WHERE NOT n."pending"),
		coalesce(sum(n."message_count") FILTER (WHERE NOT n."pending"), 0),
		coalesce(sum(n."tokens_in") FILTER (WHERE NOT n."pending"), 0),
		coalesce(sum(n."tokens_out") FILTER (WHERE NOT n."pending"), 0),
		coalesce(sum(n."cost_micros") FILTER (WHERE NOT n."pending"), 0),
		sum(n."message_count"),
		sum(n."tokens_in"::bigint + n."tokens_out" + n."reserved_tokens"),
		sum(n."cost_micros" + n."reserved_cost_micros")
	FROM "usage_rollup_new" n
	WHERE n."in_rollup"
	GROUP BY 1, 2, 3;
	RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "usage_event_rollup_update"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "usage_rollup_change" ("hour", "user_id", "model_slug", "events", "settled_events",
		"messages", "tokens_in", "tokens_out", "cost_micros", "quota_messages", "quota_tokens", "quota_cost_micros")
	SELECT c."hour", c."user_id", c."model_slug", sum(c."events"), sum(c."settled_events"),
		sum(c."messages"), sum(c."tokens_in"), sum(c."tokens_out"), sum(c."cost_micros"),
		sum(c."quota_messages"), sum(c."quota_tokens"), sum(c."quota_cost_micros")
	FROM (
		SELECT date_trunc('hour', n."occurred_at", 'UTC') AS "hour", n."user_id", n."model_slug",
			1 AS "events",
			CASE WHEN n."pending" THEN 0 ELSE 1 END AS "settled_events",
			CASE WHEN n."pending" THEN 0 ELSE n."message_count" END AS "messages",
			CASE WHEN n."pending" THEN 0 ELSE n."tokens_in" END AS "tokens_in",
			CASE WHEN n."pending" THEN 0 ELSE n."tokens_out" END AS "tokens_out",
			CASE WHEN n."pending" THEN 0 ELSE n."cost_micros" END AS "cost_micros",
			n."message_count" AS "quota_messages",
			n."tokens_in"::bigint + n."tokens_out" + n."reserved_tokens" AS "quota_tokens",
			n."cost_micros" + n."reserved_cost_micros" AS "quota_cost_micros"
		FROM "usage_rollup_new" n
		WHERE n."in_rollup"
		UNION ALL
		SELECT date_trunc('hour', o."occurred_at", 'UTC'), o."user_id", o."model_slug",
			-1,
			CASE WHEN o."pending" THEN 0 ELSE -1 END,
			CASE WHEN o."pending" THEN 0 ELSE -o."message_count" END,
			CASE WHEN o."pending" THEN 0 ELSE -o."tokens_in" END,
			CASE WHEN o."pending" THEN 0 ELSE -o."tokens_out" END,
			CASE WHEN o."pending" THEN 0 ELSE -o."cost_micros" END,
			-o."message_count",
			-(o."tokens_in"::bigint + o."tokens_out" + o."reserved_tokens"),
			-(o."cost_micros" + o."reserved_cost_micros")
		FROM "usage_rollup_old" o
		WHERE o."in_rollup"
	) c
	GROUP BY 1, 2, 3
	HAVING sum(c."events") <> 0 OR sum(c."settled_events") <> 0 OR sum(c."messages") <> 0
		OR sum(c."tokens_in") <> 0 OR sum(c."tokens_out") <> 0 OR sum(c."cost_micros") <> 0
		OR sum(c."quota_messages") <> 0 OR sum(c."quota_tokens") <> 0 OR sum(c."quota_cost_micros") <> 0;
	RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "usage_event_rollup_delete"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "usage_rollup_change" ("hour", "user_id", "model_slug", "events", "settled_events",
		"messages", "tokens_in", "tokens_out", "cost_micros", "quota_messages", "quota_tokens", "quota_cost_micros")
	SELECT date_trunc('hour', o."occurred_at", 'UTC'), o."user_id", o."model_slug",
		-count(*),
		-count(*) FILTER (WHERE NOT o."pending"),
		-coalesce(sum(o."message_count") FILTER (WHERE NOT o."pending"), 0),
		-coalesce(sum(o."tokens_in") FILTER (WHERE NOT o."pending"), 0),
		-coalesce(sum(o."tokens_out") FILTER (WHERE NOT o."pending"), 0),
		-coalesce(sum(o."cost_micros") FILTER (WHERE NOT o."pending"), 0),
		-sum(o."message_count"),
		-sum(o."tokens_in"::bigint + o."tokens_out" + o."reserved_tokens"),
		-sum(o."cost_micros" + o."reserved_cost_micros")
	FROM "usage_rollup_old" o
	WHERE o."in_rollup"
	GROUP BY 1, 2, 3;
	RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "usage_event_mark_in_rollup" ON "usage_event";
--> statement-breakpoint
CREATE TRIGGER "usage_event_mark_in_rollup" BEFORE INSERT OR UPDATE ON "usage_event"
	FOR EACH ROW EXECUTE FUNCTION "usage_event_mark_in_rollup"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "usage_event_rollup_insert" ON "usage_event";
--> statement-breakpoint
CREATE TRIGGER "usage_event_rollup_insert" AFTER INSERT ON "usage_event"
	REFERENCING NEW TABLE AS "usage_rollup_new"
	FOR EACH STATEMENT EXECUTE FUNCTION "usage_event_rollup_insert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "usage_event_rollup_update" ON "usage_event";
--> statement-breakpoint
CREATE TRIGGER "usage_event_rollup_update" AFTER UPDATE ON "usage_event"
	REFERENCING OLD TABLE AS "usage_rollup_old" NEW TABLE AS "usage_rollup_new"
	FOR EACH STATEMENT EXECUTE FUNCTION "usage_event_rollup_update"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "usage_event_rollup_delete" ON "usage_event";
--> statement-breakpoint
CREATE TRIGGER "usage_event_rollup_delete" AFTER DELETE ON "usage_event"
	REFERENCING OLD TABLE AS "usage_rollup_old"
	FOR EACH STATEMENT EXECUTE FUNCTION "usage_event_rollup_delete"();

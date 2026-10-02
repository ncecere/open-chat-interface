-- MCP connectors (v0.8). Administrators register remote MCP servers
-- (Streamable HTTP); their tools can then be enabled one by one and allowed
-- per role. See docs/dev/tools-design.md, "MCP connectors", and
-- docs/admin/connectors.md.
--
-- `connector` holds the server, its authentication mode and encrypted
-- credentials (a shared header value, an OAuth client secret).
-- `connector_tool` holds the tools the server listed, each disabled until an
-- administrator enables it. `connector_account` holds each person's encrypted
-- OAuth tokens and, while they connect, one short-lived pending authorization
-- whose state is stored only as a hash.
--
-- Tools and accounts cascade from their connector; accounts also cascade from
-- the person. Per-role allows for connector tools live in the `roleTools`
-- instance setting and are removed by the application when a connector is
-- deleted.
--
-- Migrations run inside one transaction: the tables are new and empty, so
-- nothing existing is rewritten or locked beyond validating foreign keys on
-- empty tables.
CREATE TABLE IF NOT EXISTS "connector" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"shared_header_name" text DEFAULT 'Authorization' NOT NULL,
	"encrypted_shared_header_value" text,
	"oauth_client_id" text,
	"encrypted_oauth_client_secret" text,
	"oauth_client_source" text,
	"oauth_authorization_server" text,
	"oauth_token_endpoint" text,
	"oauth_scopes" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"last_contact_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_auth_mode" CHECK ("auth_mode" in ('none', 'shared', 'oauth')),
	CONSTRAINT "connector_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
	CONSTRAINT "connector_slug_format" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$')
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector" ADD CONSTRAINT "connector_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_slug_unique" ON "connector" ("organization_id","slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_tool" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"connector_id" text NOT NULL,
	"name" text NOT NULL,
	"tool_key" text NOT NULL,
	"title" text,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb NOT NULL,
	"server_kind" text NOT NULL,
	"kind" text NOT NULL,
	"read_confirmed" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_tool_kind" CHECK ("kind" in ('read', 'write')),
	CONSTRAINT "connector_tool_server_kind" CHECK ("server_kind" in ('read', 'write'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector_tool" ADD CONSTRAINT "connector_tool_connector_id_connector_id_fk"
		FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_tool_name_unique" ON "connector_tool" ("connector_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_tool_key_unique" ON "connector_tool" ("connector_id","tool_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_account" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"connector_id" text NOT NULL,
	"user_id" text NOT NULL,
	"encrypted_tokens" text,
	"expires_at" timestamp with time zone,
	"disconnected_reason" text,
	"pending_state_hash" text,
	"encrypted_pending" text,
	"pending_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector_account" ADD CONSTRAINT "connector_account_connector_id_connector_id_fk"
		FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "connector_account" ADD CONSTRAINT "connector_account_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_account_unique" ON "connector_account" ("connector_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_account_user_idx" ON "connector_account" ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_account_pending_state_unique" ON "connector_account" ("pending_state_hash")
	WHERE "pending_state_hash" IS NOT NULL;

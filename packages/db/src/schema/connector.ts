import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { organization } from './organization.js';

/**
 * A remote MCP server (Streamable HTTP) registered by an administrator
 * (migration 0027). Secrets are AES-256-GCM ciphertext from
 * `apps/api/src/lib/crypto.ts` and are never returned to clients.
 *
 * The slug is fixed at creation: connector tool ids (`mcp__<slug>__<tool>`),
 * per-role allows and audit events refer to it.
 */
export const connector = pgTable(
  'connector',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    url: text('url').notNull(),
    authMode: text('auth_mode').$type<'none' | 'shared' | 'oauth'>().notNull().default('none'),
    /** Header the shared credential is sent in, such as `Authorization`. */
    sharedHeaderName: text('shared_header_name').notNull().default('Authorization'),
    encryptedSharedHeaderValue: text('encrypted_shared_header_value'),
    /** Manual OAuth client, or the one OCI registered dynamically (`oauth_client_source`). */
    oauthClientId: text('oauth_client_id'),
    encryptedOauthClientSecret: text('encrypted_oauth_client_secret'),
    oauthClientSource: text('oauth_client_source').$type<'manual' | 'dynamic'>(),
    /**
     * The authorization server and token endpoint discovered when the client
     * was registered, so a dynamic client is only ever used with the server
     * that issued it.
     */
    oauthAuthorizationServer: text('oauth_authorization_server'),
    oauthTokenEndpoint: text('oauth_token_endpoint'),
    oauthScopes: text('oauth_scopes').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** Allows plain HTTP and private, loopback and link-local addresses. */
    allowPrivateNetwork: boolean('allow_private_network').notNull().default(false),
    /** Last successful exchange with the server, and the last failure (a short, safe message). */
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('connector_slug_unique').on(t.organizationId, t.slug),
    check('connector_auth_mode', sql`${t.authMode} in ('none', 'shared', 'oauth')`),
    check('connector_name_length', sql`char_length(${t.name}) between 1 and 80`),
    check('connector_slug_format', sql`${t.slug} ~ '^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$'`),
  ],
);

/**
 * One tool a connector's server listed. New tools start disabled; `kind`
 * defaults from the server's `readOnlyHint` annotation (`write` when absent).
 * Runtime calls use the stored description and schema, so a server cannot
 * change what models see without an administrator refreshing.
 */
export const connectorTool = pgTable(
  'connector_tool',
  {
    id: primaryId(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    /** The tool's name on the MCP server. */
    name: text('name').notNull(),
    /** Provider-safe key used in the tool id; stable once assigned. */
    toolKey: text('tool_key').notNull(),
    title: text('title'),
    description: text('description').notNull().default(''),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    /** What the server declares; `kind` is what OCI enforces. */
    serverKind: text('server_kind').$type<'read' | 'write'>().notNull(),
    kind: text('kind').$type<'read' | 'write'>().notNull(),
    /** An administrator confirmed `read` for a tool the server does not declare read-only. */
    readConfirmed: boolean('read_confirmed').notNull().default(false),
    enabled: boolean('enabled').notNull().default(false),
    /** Not listed at the last refresh. Never offered while missing. */
    missing: boolean('missing').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('connector_tool_name_unique').on(t.connectorId, t.name),
    uniqueIndex('connector_tool_key_unique').on(t.connectorId, t.toolKey),
    check('connector_tool_kind', sql`${t.kind} in ('read', 'write')`),
    check('connector_tool_server_kind', sql`${t.serverKind} in ('read', 'write')`),
  ],
);

/**
 * A person's OAuth connection to a connector. `encrypted_tokens` holds the
 * token response and the OAuth client it was issued to; null means not
 * connected (never connected, disconnected, or refused at refresh, which sets
 * `disconnected_reason`). The `pending_*` columns hold one short-lived
 * authorization in progress: the state is stored only as a hash and is bound
 * to this person. Goes with the person and with the connector.
 */
export const connectorAccount = pgTable(
  'connector_account',
  {
    id: primaryId(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connector.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    encryptedTokens: text('encrypted_tokens'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    disconnectedReason: text('disconnected_reason'),
    pendingStateHash: text('pending_state_hash'),
    encryptedPending: text('encrypted_pending'),
    pendingExpiresAt: timestamp('pending_expires_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('connector_account_unique').on(t.connectorId, t.userId),
    index('connector_account_user_idx').on(t.userId),
    uniqueIndex('connector_account_pending_state_unique')
      .on(t.pendingStateHash)
      .where(sql`${t.pendingStateHash} is not null`),
  ],
);

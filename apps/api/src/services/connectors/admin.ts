import { and, asc, count, eq, inArray, isNotNull, schema } from '@oci/db';
import {
  type AdminConnector,
  type ConnectorRefreshResult,
  type ConnectorTestResult,
  type ConnectorTool,
  type CreateConnectorInput,
  connectorToolId,
  type UpdateConnectorInput,
  type UpdateConnectorToolInput,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { encryptSecret } from '../../lib/crypto.js';
import { AppError, conflict, notFound, validationFailed } from '../../lib/errors.js';
import { getDefaultOrganizationId } from '../organization.js';
import { forgetRoleTools } from '../tools/role-tools.js';
import { withMcpClient } from './client.js';
import { slugFromName, toolKeyFor } from './ids.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { assertAllowedUrl, ConnectorNetworkError } from './network.js';
import { connectionAuthFor, oauthRedirectUrl } from './oauth.js';
import { type ConnectorRow, type ConnectorToolRow, findAccount, findConnector } from './store.js';
import { invalidateConnectorCatalog } from './tools.js';

/** Administration of connectors: CRUD, refreshing tools, and per-tool switches. */

export async function loadConnectorOrThrow(id: string): Promise<ConnectorRow> {
  const row = await findConnector(id);
  if (!row) throw notFound('Connector not found');
  return row;
}

function serializeTool(
  connector: Pick<ConnectorRow, 'slug'>,
  tool: ConnectorToolRow,
): ConnectorTool {
  return {
    id: tool.id,
    toolId: connectorToolId(connector.slug, tool.toolKey),
    name: tool.name,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    serverKind: tool.serverKind,
    enabled: tool.enabled,
    missing: tool.missing,
    lastSeenAt: tool.lastSeenAt.toISOString(),
  };
}

/** A connector as administrators see it: secrets only as set or not set. */
function serializeConnector(
  row: ConnectorRow,
  tools: ConnectorToolRow[],
  accountCount: number,
): AdminConnector {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: row.url,
    authMode: row.authMode,
    sharedHeaderName: row.sharedHeaderName,
    hasSharedCredential: Boolean(row.encryptedSharedHeaderValue),
    oauthClientId: row.oauthClientId,
    hasOauthClientSecret: Boolean(row.encryptedOauthClientSecret),
    oauthClientSource: row.oauthClientSource,
    oauthScopes: row.oauthScopes,
    enabled: row.enabled,
    allowPrivateNetwork: row.allowPrivateNetwork,
    accountCount,
    lastContactAt: row.lastContactAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    oauthRedirectUrl: oauthRedirectUrl(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tools: tools.map((tool) => serializeTool(row, tool)),
  };
}

export async function listConnectors(ids?: string[]): Promise<AdminConnector[]> {
  const organizationId = await getDefaultOrganizationId();
  const rows = await db
    .select()
    .from(schema.connector)
    .where(
      and(
        eq(schema.connector.organizationId, organizationId),
        ids ? inArray(schema.connector.id, ids) : undefined,
      ),
    )
    .orderBy(asc(schema.connector.name));
  if (rows.length === 0) return [];
  const connectorIds = rows.map((row) => row.id);
  const [tools, accounts] = await Promise.all([
    db
      .select()
      .from(schema.connectorTool)
      .where(inArray(schema.connectorTool.connectorId, connectorIds))
      .orderBy(asc(schema.connectorTool.name)),
    db
      .select({ connectorId: schema.connectorAccount.connectorId, value: count() })
      .from(schema.connectorAccount)
      .where(
        and(
          inArray(schema.connectorAccount.connectorId, connectorIds),
          isNotNull(schema.connectorAccount.encryptedTokens),
        ),
      )
      .groupBy(schema.connectorAccount.connectorId),
  ]);
  return rows.map((row) =>
    serializeConnector(
      row,
      tools.filter((tool) => tool.connectorId === row.id),
      accounts.find((entry) => entry.connectorId === row.id)?.value ?? 0,
    ),
  );
}

export async function getAdminConnector(id: string): Promise<AdminConnector> {
  const [connector] = await listConnectors([id]);
  if (!connector) throw notFound('Connector not found');
  return connector;
}

/** Scheme and literal-address checks at save time; resolved names are checked on every connection. */
function assertSavableUrl(url: string, allowPrivateNetwork: boolean) {
  try {
    assertAllowedUrl(url, { allowPrivateNetwork });
  } catch (error) {
    if (error instanceof ConnectorNetworkError)
      throw validationFailed(error.message, [{ path: ['url'], message: error.message }]);
    throw error;
  }
}

async function uniqueSlug(organizationId: string, wanted: string, explicit: boolean) {
  const taken = new Set(
    (
      await db
        .select({ slug: schema.connector.slug })
        .from(schema.connector)
        .where(eq(schema.connector.organizationId, organizationId))
    ).map((row) => row.slug),
  );
  if (!taken.has(wanted)) return wanted;
  if (explicit) throw conflict('Another connector already uses this short name.');
  for (let suffix = 2; ; suffix++) {
    const candidate = `${wanted.slice(0, 24 - String(suffix).length - 1).replace(/-+$/, '')}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function createConnector(input: CreateConnectorInput): Promise<ConnectorRow> {
  assertSavableUrl(input.url, input.allowPrivateNetwork);
  const organizationId = await getDefaultOrganizationId();
  const slug = await uniqueSlug(
    organizationId,
    input.slug ?? slugFromName(input.name),
    Boolean(input.slug),
  );
  const [created] = await db
    .insert(schema.connector)
    .values({
      organizationId,
      name: input.name,
      slug,
      url: input.url,
      authMode: input.authMode,
      sharedHeaderName: input.sharedHeaderName,
      encryptedSharedHeaderValue: input.sharedHeaderValue
        ? encryptSecret(input.sharedHeaderValue)
        : null,
      oauthClientId: input.oauthClientId ?? null,
      encryptedOauthClientSecret: input.oauthClientSecret
        ? encryptSecret(input.oauthClientSecret)
        : null,
      oauthClientSource: input.oauthClientId ? 'manual' : null,
      oauthScopes: input.oauthScopes,
      enabled: input.enabled,
      allowPrivateNetwork: input.allowPrivateNetwork,
    })
    .returning();
  invalidateConnectorCatalog();
  return created!;
}

const credentialChange = (value: string | null | undefined) =>
  value === undefined ? 'unchanged' : value === null ? 'cleared' : 'replaced';

/**
 * Applies an administrator's change. Changing where the server is, how it
 * authenticates or which OAuth client it uses ends every person's connection
 * (their tokens were issued for the old setup) and forgets the pinned
 * authorization server and any dynamically registered client.
 */
export async function updateConnector(
  existing: ConnectorRow,
  input: UpdateConnectorInput,
): Promise<{
  row: ConnectorRow;
  fields: string[];
  credentials: Record<string, string>;
  accountsRemoved: number;
}> {
  const next = {
    name: input.name ?? existing.name,
    url: input.url ?? existing.url,
    authMode: input.authMode ?? existing.authMode,
    sharedHeaderName: input.sharedHeaderName ?? existing.sharedHeaderName,
    oauthScopes: input.oauthScopes ?? existing.oauthScopes,
    enabled: input.enabled ?? existing.enabled,
    allowPrivateNetwork: input.allowPrivateNetwork ?? existing.allowPrivateNetwork,
  };
  assertSavableUrl(next.url, next.allowPrivateNetwork);

  const values: Partial<typeof schema.connector.$inferInsert> = { ...next, updatedAt: new Date() };
  if (input.sharedHeaderValue !== undefined)
    values.encryptedSharedHeaderValue = input.sharedHeaderValue
      ? encryptSecret(input.sharedHeaderValue)
      : null;
  const clientChanged =
    input.oauthClientId !== undefined && input.oauthClientId !== existing.oauthClientId;
  if (clientChanged) {
    values.oauthClientId = input.oauthClientId ?? null;
    values.oauthClientSource = input.oauthClientId ? 'manual' : null;
    // A secret belongs to its client: a new client without a new secret has none.
    if (input.oauthClientSecret === undefined) values.encryptedOauthClientSecret = null;
  }
  if (input.oauthClientSecret !== undefined)
    values.encryptedOauthClientSecret = input.oauthClientSecret
      ? encryptSecret(input.oauthClientSecret)
      : null;
  const sharedValue =
    input.sharedHeaderValue === undefined
      ? existing.encryptedSharedHeaderValue
      : input.sharedHeaderValue;
  if (next.authMode === 'shared' && !sharedValue)
    throw validationFailed('Enter the credential OCI sends to this server.', [
      { path: ['sharedHeaderValue'], message: 'Enter the credential OCI sends to this server.' },
    ]);

  const resetsConnections =
    next.url !== existing.url || next.authMode !== existing.authMode || clientChanged;
  if (resetsConnections) {
    values.oauthAuthorizationServer = null;
    values.oauthTokenEndpoint = null;
    // A dynamically registered client was registered for the old setup.
    if (!clientChanged && existing.oauthClientSource === 'dynamic') {
      values.oauthClientId = null;
      values.encryptedOauthClientSecret = null;
      values.oauthClientSource = null;
    }
  }

  const { row, accountsRemoved } = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.connector)
      .set(values)
      .where(eq(schema.connector.id, existing.id))
      .returning();
    let accountsRemoved = 0;
    if (resetsConnections) {
      const removed = await tx
        .delete(schema.connectorAccount)
        .where(eq(schema.connectorAccount.connectorId, existing.id))
        .returning({
          id: schema.connectorAccount.id,
          tokens: schema.connectorAccount.encryptedTokens,
        });
      accountsRemoved = removed.filter((entry) => entry.tokens).length;
    }
    return { row: row!, accountsRemoved };
  });
  invalidateConnectorCatalog();
  return {
    row,
    fields: Object.keys(input).filter(
      (key) => !['sharedHeaderValue', 'oauthClientSecret'].includes(key),
    ),
    credentials: {
      sharedHeaderValue: credentialChange(input.sharedHeaderValue),
      oauthClientSecret: credentialChange(input.oauthClientSecret),
    },
    accountsRemoved,
  };
}

/**
 * Deletes a connector with its tools and every person's connection, and
 * forgets each role's saved choice for its tools.
 */
export async function deleteConnector(
  connector: ConnectorRow,
): Promise<{ tools: number; accounts: number }> {
  const [tools, accounts] = await Promise.all([
    db
      .select({ value: count() })
      .from(schema.connectorTool)
      .where(eq(schema.connectorTool.connectorId, connector.id)),
    db
      .select({ value: count() })
      .from(schema.connectorAccount)
      .where(
        and(
          eq(schema.connectorAccount.connectorId, connector.id),
          isNotNull(schema.connectorAccount.encryptedTokens),
        ),
      ),
  ]);
  await db.delete(schema.connector).where(eq(schema.connector.id, connector.id));
  invalidateConnectorCatalog();
  await forgetRoleTools(connectorToolId(connector.slug, ''));
  return { tools: tools[0]?.value ?? 0, accounts: accounts[0]?.value ?? 0 };
}

/** Credentials for an administrator's own test or refresh of a connector. */
async function adminConnectionAuth(connector: ConnectorRow, adminUserId: string) {
  if (connector.authMode !== 'oauth') return connectionAuthFor(connector, adminUserId);
  const account = await findAccount(connector.id, adminUserId);
  if (!account?.encryptedTokens) return null;
  return connectionAuthFor(connector, adminUserId);
}

/**
 * Checks that the server answers the MCP handshake and lists tools. An OAuth
 * connector is tested with the administrator's own connection; without one,
 * only that the server is reachable and asks for sign-in.
 */
export async function testConnector(
  connector: ConnectorRow,
  adminUserId: string,
): Promise<ConnectorTestResult> {
  const auth = await adminConnectionAuth(connector, adminUserId).catch((error: unknown) => {
    if (error instanceof AppError) return error;
    throw error;
  });
  if (auth instanceof AppError) return { ok: false, detail: auth.message };
  try {
    const detail = await withMcpClient(
      connector,
      auth ?? {},
      AbortSignal.timeout(CONNECTOR_LIMITS.timeoutMs),
      async (client) => {
        const listed = await client.listTools({
          options: { timeout: CONNECTOR_LIMITS.timeoutMs },
        });
        const server = [client.serverInfo.name, client.serverInfo.version]
          .filter(Boolean)
          .join(' ');
        const more = listed.nextCursor ? '+' : '';
        return `Connected${server ? ` to ${server}` : ''} · ${listed.tools.length}${more} tool${listed.tools.length === 1 && !more ? '' : 's'}`;
      },
    );
    return { ok: true, detail };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (connector.authMode === 'oauth' && !auth && /HTTP 401|refused OCI/.test(error.message))
      return {
        ok: true,
        detail:
          'Reachable. It asks each person to sign in; connect your own account to refresh its tools.',
      };
    return { ok: false, detail: error.message };
  }
}

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown> & { title?: string };
};

/** `read` only when the server declares the tool read-only. */
export const serverKindOf = (tool: Pick<ListedTool, 'annotations'>): 'read' | 'write' =>
  tool.annotations?.readOnlyHint === true ? 'read' : 'write';

/** 1–128 characters, none of them control characters. */
const validToolName = (name: string) =>
  name.length >= 1 &&
  name.length <= 128 &&
  [...name].every((character) => character.charCodeAt(0) >= 0x20 && character !== '\x7f');

/**
 * Lists the server's tools (`tools/list`) and stores them: new tools arrive
 * disabled with a kind from `readOnlyHint`; known tools get the server's
 * current description and schema; tools no longer listed are marked missing
 * and stop being offered. A tool the server stops declaring read-only goes
 * back to `write` unless an administrator confirmed `read` for it.
 */
export async function refreshConnectorTools(
  connector: ConnectorRow,
  adminUserId: string,
): Promise<ConnectorRefreshResult> {
  const auth = await adminConnectionAuth(connector, adminUserId);
  if (!auth)
    throw validationFailed(
      `Connect your own ${connector.name} account first (Connect your account on this page). Its tools are listed with your sign-in.`,
    );
  const listed = await withMcpClient(
    connector,
    auth,
    AbortSignal.timeout(CONNECTOR_LIMITS.timeoutMs * 2),
    async (client) => {
      const tools: ListedTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await client.listTools({
          ...(cursor ? { params: { cursor } } : {}),
          options: { timeout: CONNECTOR_LIMITS.timeoutMs },
        });
        tools.push(...(result.tools as ListedTool[]));
        cursor = result.nextCursor;
        if (!cursor || tools.length >= CONNECTOR_LIMITS.maxTools) break;
      }
      return tools.slice(0, CONNECTOR_LIMITS.maxTools);
    },
  );

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.connectorTool)
      .where(eq(schema.connectorTool.connectorId, connector.id));
    const byName = new Map(existing.map((tool) => [tool.name, tool]));
    const taken = new Set(existing.map((tool) => tool.toolKey));
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;
    for (const tool of listed) {
      if (!validToolName(tool.name) || seen.has(tool.name)) continue;
      const schemaText = JSON.stringify(tool.inputSchema ?? {});
      if (schemaText.length > CONNECTOR_LIMITS.maxSchemaChars) continue;
      seen.add(tool.name);
      const serverKind = serverKindOf(tool);
      const title = (tool.title ?? tool.annotations?.title ?? null)?.slice(0, 200) ?? null;
      const description = (tool.description ?? '').slice(0, 4_000);
      const inputSchema = { ...tool.inputSchema, type: 'object' } as Record<string, unknown>;
      const known = byName.get(tool.name);
      if (known) {
        const kind =
          serverKind === 'write' && known.kind === 'read' && !known.readConfirmed
            ? 'write'
            : known.kind;
        await tx
          .update(schema.connectorTool)
          .set({
            title,
            description,
            inputSchema,
            serverKind,
            kind,
            missing: false,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(schema.connectorTool.id, known.id));
        updated++;
      } else {
        const toolKey = toolKeyFor(connector.slug, tool.name, taken);
        taken.add(toolKey);
        await tx.insert(schema.connectorTool).values({
          connectorId: connector.id,
          name: tool.name,
          toolKey,
          title,
          description,
          inputSchema,
          serverKind,
          kind: serverKind,
          enabled: false,
          lastSeenAt: now,
        });
        added++;
      }
    }
    const gone = existing.filter((tool) => !seen.has(tool.name) && !tool.missing);
    if (gone.length)
      await tx
        .update(schema.connectorTool)
        .set({ missing: true, updatedAt: now })
        .where(
          inArray(
            schema.connectorTool.id,
            gone.map((tool) => tool.id),
          ),
        );
    const missing = existing.filter((tool) => !seen.has(tool.name)).length;
    return { added, updated, missing };
  });
  invalidateConnectorCatalog();
  const tools = await db
    .select()
    .from(schema.connectorTool)
    .where(eq(schema.connectorTool.connectorId, connector.id))
    .orderBy(asc(schema.connectorTool.name));
  return { ...result, tools: tools.map((tool) => serializeTool(connector, tool)) };
}

/**
 * Switches one tool on or off, or changes its kind. Marking `write` is always
 * allowed (it only adds approval). Marking `read` a tool the server does not
 * declare read-only lets it run without asking, so it needs `confirmReadOnly`.
 */
export async function updateConnectorTool(
  connector: ConnectorRow,
  toolRowId: string,
  input: UpdateConnectorToolInput,
): Promise<{ tool: ConnectorTool; changes: Record<string, { before: unknown; after: unknown }> }> {
  const [tool] = await db
    .select()
    .from(schema.connectorTool)
    .where(
      and(
        eq(schema.connectorTool.id, toolRowId),
        eq(schema.connectorTool.connectorId, connector.id),
      ),
    )
    .limit(1);
  if (!tool) throw notFound('Tool not found');
  const values: Partial<typeof schema.connectorTool.$inferInsert> = { updatedAt: new Date() };
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (input.enabled !== undefined && input.enabled !== tool.enabled) {
    values.enabled = input.enabled;
    changes.enabled = { before: tool.enabled, after: input.enabled };
  }
  if (input.kind !== undefined && input.kind !== tool.kind) {
    if (input.kind === 'read' && tool.serverKind === 'write' && input.confirmReadOnly !== true)
      throw validationFailed(
        'The server does not declare this tool read-only. Confirm that it only looks things up before letting it run without approval.',
        [{ path: ['confirmReadOnly'], message: 'Confirmation required.' }],
      );
    values.kind = input.kind;
    values.readConfirmed = input.kind === 'read' && tool.serverKind === 'write';
    changes.kind = { before: tool.kind, after: input.kind };
  }
  const [updated] = await db
    .update(schema.connectorTool)
    .set(values)
    .where(eq(schema.connectorTool.id, tool.id))
    .returning();
  invalidateConnectorCatalog();
  return { tool: serializeTool(connector, updated!), changes };
}

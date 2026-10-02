import { and, eq, inArray, schema } from '@oci/db';
import type { UserConnector, UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { getSetting } from '../settings.js';
import { resolveRoleToolAllowed } from '../tools/role-tools.js';
import type { ConnectorRow } from './store.js';
import { connectorTools } from './tools.js';

/** How many of each connector's offered tools this role may use. */
async function allowedToolCounts(role: UserRole): Promise<Map<string, number>> {
  const [tools, stored] = await Promise.all([connectorTools(), getSetting('roleTools')]);
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (!tool.connector || !resolveRoleToolAllowed(role, tool, stored)) continue;
    counts.set(tool.connector.id, (counts.get(tool.connector.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * OAuth connectors a person can use (at least one enabled tool allowed for
 * their role), with whether they are connected. Connectors with no sign-in or
 * a shared credential need nothing from the person and are not listed.
 */
export async function userConnectors(user: {
  id: string;
  role: UserRole;
}): Promise<UserConnector[]> {
  const counts = await allowedToolCounts(user.role);
  if (counts.size === 0) return [];
  const rows = await db
    .select({
      id: schema.connector.id,
      name: schema.connector.name,
      slug: schema.connector.slug,
      tokens: schema.connectorAccount.encryptedTokens,
      disconnectedReason: schema.connectorAccount.disconnectedReason,
    })
    .from(schema.connector)
    .leftJoin(
      schema.connectorAccount,
      and(
        eq(schema.connectorAccount.connectorId, schema.connector.id),
        eq(schema.connectorAccount.userId, user.id),
      ),
    )
    .where(
      and(
        inArray(schema.connector.id, [...counts.keys()]),
        eq(schema.connector.enabled, true),
        eq(schema.connector.authMode, 'oauth'),
      ),
    )
    .orderBy(schema.connector.name);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    connected: Boolean(row.tokens),
    needsReconnect: !row.tokens && Boolean(row.disconnectedReason),
    toolCount: counts.get(row.id) ?? 0,
  }));
}

/**
 * The connector a person may connect to: enabled, OAuth, and with a tool
 * their role may use. Administrators may also connect before any tool is
 * allowed, so they can list its tools. Anything else is not found.
 */
export async function connectableConnector(
  user: { role: UserRole },
  connectorId: string,
): Promise<ConnectorRow> {
  const [connector] = await db
    .select()
    .from(schema.connector)
    .where(eq(schema.connector.id, connectorId))
    .limit(1);
  if (!connector?.enabled || connector.authMode !== 'oauth') throw notFound('Connector not found');
  if (user.role !== 'admin' && !(await allowedToolCounts(user.role)).get(connector.id))
    throw notFound('Connector not found');
  return connector;
}

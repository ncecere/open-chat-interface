import { and, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { connectorFetch } from './client.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { ConnectorNetworkError } from './network.js';
import { clientInformation } from './oauth-client.js';
import type { StoredConnection } from './oauth-tokens.js';
import type { ConnectorRow } from './store.js';

/**
 * OAuth for connectors whose people each connect their own account
 * (authorization code with PKCE, through `@ai-sdk/mcp`'s `auth`).
 *
 * - Discovery, dynamic client registration, the code exchange and refresh
 *   all go through the connector's guarded fetch, so OAuth endpoints get the
 *   same address checks as the MCP server.
 * - The authorization server is pinned on the connector the first time anyone
 *   connects; a server that later names a different one is refused until an
 *   administrator saves the connector again.
 * - The state is random, stored only as a hash on the person's account row,
 *   bound to that person and valid for ten minutes, and used once.
 */

export {
  ConnectorOAuthError,
  type ConnectReturn,
  oauthRedirectUrl,
} from './oauth-client.js';
export { completeConnect, startConnect } from './oauth-connect.js';
export { connectionAuthFor, reconnectMessage } from './oauth-refresh.js';

/**
 * Disconnects a person: deletes their tokens, then asks the authorization
 * server to revoke them (RFC 7009) when it advertises a revocation endpoint.
 * Revocation is best effort and never blocks the disconnect.
 */
export async function disconnectAccount(
  userId: string,
  connector: ConnectorRow,
): Promise<{ existed: boolean; revoked: boolean }> {
  const [removed] = await db
    .delete(schema.connectorAccount)
    .where(
      and(
        eq(schema.connectorAccount.connectorId, connector.id),
        eq(schema.connectorAccount.userId, userId),
      ),
    )
    .returning({ encryptedTokens: schema.connectorAccount.encryptedTokens });
  if (!removed) return { existed: false, revoked: false };
  if (!removed.encryptedTokens) return { existed: true, revoked: false };
  try {
    const connection = JSON.parse(decryptSecret(removed.encryptedTokens)) as StoredConnection;
    return { existed: true, revoked: await revoke(connector, connection) };
  } catch (error) {
    if (!(error instanceof ConnectorNetworkError))
      logger.warn({ err: error, connectorId: connector.id }, 'Connector token revocation failed');
    return { existed: true, revoked: false };
  }
}

async function revoke(connector: ConnectorRow, connection: StoredConnection): Promise<boolean> {
  const issuer = connection.tokens.authorization_server ?? connector.oauthAuthorizationServer;
  if (!issuer) return false;
  const fetchFn = connectorFetch(connector);
  const signal = AbortSignal.timeout(Math.min(5_000, CONNECTOR_LIMITS.timeoutMs));
  const base = new URL(issuer);
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  let endpoint: string | null = null;
  for (const candidate of [
    `/.well-known/oauth-authorization-server${path}`,
    `/.well-known/openid-configuration${path}`,
  ]) {
    const response = await fetchFn(new URL(candidate, base.origin), { signal });
    if (!response.ok) {
      await response.body?.cancel();
      continue;
    }
    const metadata = (await response.json()) as { revocation_endpoint?: unknown };
    if (typeof metadata.revocation_endpoint === 'string') endpoint = metadata.revocation_endpoint;
    break;
  }
  if (!endpoint) return false;
  const client = clientInformation(connector, connection.client);
  if (!client) return false;
  const token = connection.tokens.refresh_token ?? connection.tokens.access_token;
  const params = new URLSearchParams({
    token,
    token_type_hint: connection.tokens.refresh_token ? 'refresh_token' : 'access_token',
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  // The same encoding the token exchange used, so the server accepts it alike.
  if (client.client_secret)
    headers.authorization = `Basic ${Buffer.from(
      `${client.client_id}:${client.client_secret}`,
    ).toString('base64')}`;
  else params.set('client_id', client.client_id);
  const response = await fetchFn(endpoint, { method: 'POST', headers, body: params, signal });
  await response.body?.cancel();
  return response.ok;
}

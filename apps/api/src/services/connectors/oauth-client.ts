import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
} from '@ai-sdk/mcp';
import { and, eq, isNull, schema } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import type { ConnectorRow } from './store.js';

export type ConnectReturn = 'settings' | 'admin';

/** The OAuth client a connection was made with. A manual client's secret stays on the connector. */
export interface StoredClient {
  client_id: string;
  /** Only for a dynamically registered client, which OCI holds the secret for. */
  client_secret?: string;
  source: 'manual' | 'dynamic';
}

export interface PendingAuthorization {
  returnTo: ConnectReturn;
  codeVerifier?: string;
  client?: StoredClient;
  server?: OAuthAuthorizationServerInformation;
}

/** A refused or failed connection attempt; `code` is what the settings page explains. */
export class ConnectorOAuthError extends Error {
  constructor(
    message: string,
    readonly code: 'state' | 'denied' | 'failed',
  ) {
    super(message);
    this.name = 'ConnectorOAuthError';
  }
}

/** Where authorization servers send people back. Register this with the server. */
export function oauthRedirectUrl(): string {
  return new URL('/api/connectors/oauth/callback', loadEnv().APP_URL).toString();
}

export function clientMetadata(connector: ConnectorRow): OAuthClientMetadata {
  return {
    client_name: 'Open Chat Interface',
    redirect_uris: [oauthRedirectUrl()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    ...(connector.oauthScopes ? { scope: connector.oauthScopes } : {}),
  };
}

const normalizeUrl = (value: string | URL) => new URL(value).href;

/** The client to use: the administrator's, or the one OCI registered for this connector. */
export function connectorClient(connector: ConnectorRow): StoredClient | undefined {
  if (!connector.oauthClientId) return undefined;
  if (connector.oauthClientSource === 'dynamic')
    return {
      client_id: connector.oauthClientId,
      ...(connector.encryptedOauthClientSecret
        ? { client_secret: decryptSecret(connector.encryptedOauthClientSecret) }
        : {}),
      source: 'dynamic',
    };
  return { client_id: connector.oauthClientId, source: 'manual' };
}

/** The client as the OAuth library needs it, with a manual client's current secret. */
export function clientInformation(
  connector: ConnectorRow,
  client: StoredClient,
): OAuthClientInformation | undefined {
  if (client.source === 'dynamic')
    return {
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    };
  // A manual client the administrator has since replaced is not ours to use.
  if (connector.oauthClientId !== client.client_id) return undefined;
  return {
    client_id: client.client_id,
    ...(connector.encryptedOauthClientSecret
      ? { client_secret: decryptSecret(connector.encryptedOauthClientSecret) }
      : {}),
  };
}

/** Refuses an authorization server other than the one pinned on the connector. */
export function assertPinnedServer(connector: ConnectorRow, authorizationServerUrl: string | URL) {
  if (
    connector.oauthAuthorizationServer &&
    normalizeUrl(authorizationServerUrl) !== connector.oauthAuthorizationServer
  )
    throw new ConnectorOAuthError(
      `${connector.name} now names a different sign-in server. An administrator has to save the connector again before anyone can connect.`,
      'failed',
    );
}

/** Pins the authorization server the first time it is seen, or refuses a different token endpoint. */
export async function pinServer(
  connector: ConnectorRow,
  server: OAuthAuthorizationServerInformation,
) {
  if (connector.oauthTokenEndpoint) {
    if (normalizeUrl(server.tokenEndpoint) !== connector.oauthTokenEndpoint)
      throw new ConnectorOAuthError(
        `${connector.name} now names a different sign-in server. An administrator has to save the connector again before anyone can connect.`,
        'failed',
      );
    return;
  }
  await db
    .update(schema.connector)
    .set({
      oauthAuthorizationServer: normalizeUrl(server.authorizationServerUrl),
      oauthTokenEndpoint: normalizeUrl(server.tokenEndpoint),
    })
    .where(and(eq(schema.connector.id, connector.id), isNull(schema.connector.oauthTokenEndpoint)));
}

import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import { and, eq, gt, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../../lib/crypto.js';
import { AppError, providerError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { connectorFetch } from './client.js';
import { findNetworkError } from './network.js';
import {
  assertPinnedServer,
  ConnectorOAuthError,
  type ConnectReturn,
  clientInformation,
  clientMetadata,
  connectorClient,
  oauthRedirectUrl,
  type PendingAuthorization,
  pinServer,
  type StoredClient,
} from './oauth-client.js';
import { saveConnection } from './oauth-tokens.js';
import type { ConnectorRow } from './store.js';

const OAUTH_STATE_TTL_MS = 10 * 60_000;

/** The provider for one connect attempt: start (redirect) or callback (code exchange). */
class ConnectProvider implements OAuthClientProvider {
  authorizationUrl: string | null = null;
  received: OAuthTokens | null = null;

  constructor(
    private readonly connector: ConnectorRow,
    readonly pending: PendingAuthorization,
    private readonly stateValue: string,
  ) {}

  get redirectUrl() {
    return oauthRedirectUrl();
  }
  get clientMetadata() {
    return clientMetadata(this.connector);
  }
  tokens() {
    return undefined;
  }
  saveTokens(tokens: OAuthTokens) {
    this.received = tokens;
  }
  redirectToAuthorization(url: URL) {
    // The browser goes here, not this server; still only ever a web address.
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new ConnectorOAuthError('The sign-in address is not a web address.', 'failed');
    this.authorizationUrl = url.href;
  }
  saveCodeVerifier(verifier: string) {
    this.pending.codeVerifier = verifier;
  }
  codeVerifier() {
    if (!this.pending.codeVerifier) throw new Error('No code verifier');
    return this.pending.codeVerifier;
  }
  clientInformation() {
    this.pending.client ??= connectorClient(this.connector);
    return this.pending.client ? clientInformation(this.connector, this.pending.client) : undefined;
  }
  async saveClientInformation(information: OAuthClientInformation) {
    // Dynamic registration: keep it for this attempt and, if the connector has
    // no client yet, for everyone after.
    const client: StoredClient = {
      client_id: information.client_id,
      ...(information.client_secret ? { client_secret: information.client_secret } : {}),
      source: 'dynamic',
    };
    this.pending.client = client;
    await db
      .update(schema.connector)
      .set({
        oauthClientId: client.client_id,
        encryptedOauthClientSecret: client.client_secret
          ? encryptSecret(client.client_secret)
          : null,
        oauthClientSource: 'dynamic',
      })
      .where(
        and(eq(schema.connector.id, this.connector.id), isNull(schema.connector.oauthClientId)),
      );
  }
  validateAuthorizationServerURL(_serverUrl: string | URL, authorizationServerUrl: string | URL) {
    assertPinnedServer(this.connector, authorizationServerUrl);
  }
  async saveAuthorizationServerInformation(server: OAuthAuthorizationServerInformation) {
    await pinServer(this.connector, server);
    this.pending.server = server;
  }
  authorizationServerInformation() {
    return this.pending.server;
  }
  state() {
    return this.stateValue;
  }
  storedState() {
    return this.stateValue;
  }
  invalidateCredentials() {
    // Nothing stored to forget mid-attempt.
  }
}

/** Person-facing wording for a failed connect attempt. */
function connectFailure(name: string, error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ConnectorOAuthError) return providerError(error.message);
  const network = findNetworkError(error);
  if (network) return providerError(`${name} could not be used. ${network.message}`);
  const message = error instanceof Error ? error.message : '';
  if (/dynamic client registration/i.test(message))
    return providerError(
      `${name} does not let OCI register itself. An administrator has to enter a client ID for it.`,
    );
  return providerError(`Could not start signing in to ${name}. Try again later.`);
}

/**
 * Starts connecting a person's account: discovers the server's OAuth
 * metadata, registers OCI if needed, and returns the authorization URL to send
 * the browser to. One attempt per person and connector is held at a time.
 */
export async function startConnect(
  userId: string,
  connector: ConnectorRow,
  returnTo: ConnectReturn,
): Promise<string> {
  const state = generateToken(32);
  const provider = new ConnectProvider(connector, { returnTo }, state);
  let result: string;
  try {
    result = await auth(provider, {
      serverUrl: connector.url,
      ...(connector.oauthScopes ? { scope: connector.oauthScopes } : {}),
      fetchFn: connectorFetch(connector),
    });
  } catch (error) {
    if (!findNetworkError(error) && !(error instanceof ConnectorOAuthError))
      logger.warn({ err: error, connectorId: connector.id }, 'Connector sign-in could not start');
    throw connectFailure(connector.name, error);
  }
  const { pending } = provider;
  if (
    result !== 'REDIRECT' ||
    !provider.authorizationUrl ||
    !pending.codeVerifier ||
    !pending.client
  )
    throw providerError(`Could not start signing in to ${connector.name}. Try again later.`);
  const values = {
    pendingStateHash: hashToken(state),
    encryptedPending: encryptSecret(JSON.stringify(pending)),
    pendingExpiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  };
  await db
    .insert(schema.connectorAccount)
    .values({ connectorId: connector.id, userId, ...values })
    .onConflictDoUpdate({
      target: [schema.connectorAccount.connectorId, schema.connectorAccount.userId],
      set: { ...values, updatedAt: new Date() },
    });
  return provider.authorizationUrl;
}

/**
 * Finishes a connect attempt from the authorization server's redirect. The
 * state must match an unexpired attempt of the signed-in person; it is
 * consumed before the code is exchanged, so it works once.
 */
export async function completeConnect(
  userId: string,
  query: { state?: string; code?: string; error?: string },
): Promise<{ connector: ConnectorRow; returnTo: ConnectReturn }> {
  if (!query.state) throw new ConnectorOAuthError('The sign-in response had no state.', 'state');
  const stateHash = hashToken(query.state);
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.connectorAccount)
      .where(
        and(
          eq(schema.connectorAccount.pendingStateHash, stateHash),
          eq(schema.connectorAccount.userId, userId),
          gt(schema.connectorAccount.pendingExpiresAt, new Date()),
        ),
      )
      .for('update');
    if (!row) return null;
    await tx
      .update(schema.connectorAccount)
      .set({ pendingStateHash: null, encryptedPending: null, pendingExpiresAt: null })
      .where(eq(schema.connectorAccount.id, row.id));
    return row;
  });
  if (!claimed?.encryptedPending)
    throw new ConnectorOAuthError(
      'This sign-in link is not valid any more. Start connecting again from Settings.',
      'state',
    );
  const pending = JSON.parse(decryptSecret(claimed.encryptedPending)) as PendingAuthorization;
  const [connector] = await db
    .select()
    .from(schema.connector)
    .where(eq(schema.connector.id, claimed.connectorId))
    .limit(1);
  if (!connector?.enabled || connector.authMode !== 'oauth')
    throw new ConnectorOAuthError('This connector is not available.', 'failed');
  if (query.error || !query.code)
    throw new ConnectorOAuthError(`Signing in to ${connector.name} was cancelled.`, 'denied');

  const provider = new ConnectProvider(connector, pending, query.state);
  try {
    const result = await auth(provider, {
      serverUrl: connector.url,
      authorizationCode: query.code,
      callbackState: query.state,
      fetchFn: connectorFetch(connector),
    });
    if (result !== 'AUTHORIZED' || !provider.received || !pending.client)
      throw new ConnectorOAuthError(`${connector.name} did not complete the sign-in.`, 'failed');
  } catch (error) {
    if (error instanceof ConnectorOAuthError) throw error;
    if (!findNetworkError(error))
      logger.warn({ err: error, connectorId: connector.id }, 'Connector sign-in could not finish');
    throw new ConnectorOAuthError(
      `${connector.name} did not accept the sign-in. Try connecting again.`,
      'failed',
    );
  }
  await saveConnection(claimed.id, { tokens: provider.received, client: pending.client });
  await db
    .update(schema.connectorAccount)
    .set({ connectedAt: new Date() })
    .where(eq(schema.connectorAccount.id, claimed.id));
  return { connector, returnTo: pending.returnTo === 'admin' ? 'admin' : 'settings' };
}

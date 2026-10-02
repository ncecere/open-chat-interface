import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import { and, eq, gt, isNull, schema, sql } from '@oci/db';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { decryptSecret, encryptSecret, generateToken, hashToken } from '../../lib/crypto.js';
import { AppError, providerError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type ConnectionAuth, connectorFetch } from './client.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { ConnectorNetworkError, findNetworkError } from './network.js';
import { type ConnectorAccountRow, type ConnectorRow, findAccount } from './store.js';

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

const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Tokens this close to expiry are refreshed before a call. */
const REFRESH_MARGIN_MS = 60_000;

type AccountTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where an account's writes go: the pool, or the transaction holding its row lock. */
type Executor = typeof db | AccountTransaction;

export type ConnectReturn = 'settings' | 'admin';

/** The OAuth client a connection was made with. A manual client's secret stays on the connector. */
interface StoredClient {
  client_id: string;
  /** Only for a dynamically registered client, which OCI holds the secret for. */
  client_secret?: string;
  source: 'manual' | 'dynamic';
}

interface PendingAuthorization {
  returnTo: ConnectReturn;
  codeVerifier?: string;
  client?: StoredClient;
  server?: OAuthAuthorizationServerInformation;
}

interface StoredConnection {
  tokens: OAuthTokens;
  client: StoredClient;
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

function clientMetadata(connector: ConnectorRow): OAuthClientMetadata {
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
function connectorClient(connector: ConnectorRow): StoredClient | undefined {
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
function clientInformation(
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
function assertPinnedServer(connector: ConnectorRow, authorizationServerUrl: string | URL) {
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
async function pinServer(connector: ConnectorRow, server: OAuthAuthorizationServerInformation) {
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

const expiryOf = (tokens: OAuthTokens) =>
  typeof tokens.expires_in === 'number' && tokens.expires_in > 0
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

/** Stores a connection and returns its ciphertext, which identifies this version of the tokens. */
async function saveConnection(
  accountId: string,
  connection: StoredConnection,
  executor: Executor = db,
): Promise<string> {
  const encryptedTokens = encryptSecret(JSON.stringify(connection));
  await executor
    .update(schema.connectorAccount)
    .set({
      encryptedTokens,
      expiresAt: expiryOf(connection.tokens),
      disconnectedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.connectorAccount.id, accountId));
  return encryptedTokens;
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

/**
 * Forgets a person's tokens and records why, so Settings can ask them to
 * reconnect. With `onlyTokens`, only if those are still the stored tokens:
 * returns false when another refresh replaced them meanwhile.
 */
async function markDisconnected(
  accountId: string,
  reason: string,
  executor: Executor = db,
  onlyTokens?: string,
): Promise<boolean> {
  const changed = await executor
    .update(schema.connectorAccount)
    .set({
      encryptedTokens: null,
      expiresAt: null,
      disconnectedReason: reason,
      updatedAt: new Date(),
    })
    .where(
      onlyTokens === undefined
        ? eq(schema.connectorAccount.id, accountId)
        : and(
            eq(schema.connectorAccount.id, accountId),
            eq(schema.connectorAccount.encryptedTokens, onlyTokens),
          ),
    )
    .returning({ id: schema.connectorAccount.id });
  return changed.length > 0;
}

/**
 * The provider used while calling tools: it supplies the person's tokens,
 * saves refreshed ones, and treats a refused refresh, or any need to sign in
 * again, as a lost connection (there is nobody to redirect). A refresh that
 * failed only because the network did is not a refusal: the connection is
 * kept for the next try.
 *
 * A refusal only disconnects if the tokens it refused are still the stored
 * ones. When a server rotates refresh tokens, a refresh with tokens another
 * caller (on any replica) has already replaced is refused; the provider then
 * carries on with the replacement instead of disconnecting the person.
 */
class AccountProvider implements OAuthClientProvider {
  disconnected = false;
  /** Set when a request of this refresh failed at the network level. */
  networkFailed = false;
  /** Signing in again was needed but not recorded, because the network failed. */
  transient = false;

  constructor(
    private readonly connector: ConnectorRow,
    private readonly accountId: string,
    private connection: StoredConnection,
    /** The stored ciphertext `connection` was read from. */
    private storedTokens: string,
    private readonly executor: Executor = db,
  ) {}

  /** The connector's guarded fetch, noting network failures. */
  readonly fetchFn: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await connectorFetch(this.connector)(input, init);
    } catch (error) {
      this.networkFailed = true;
      throw error;
    }
  }) as typeof fetch;

  get redirectUrl() {
    return oauthRedirectUrl();
  }
  get clientMetadata() {
    return clientMetadata(this.connector);
  }
  tokens() {
    return this.disconnected ? undefined : this.connection.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.connection = { ...this.connection, tokens };
    this.storedTokens = await saveConnection(this.accountId, this.connection, this.executor);
  }
  async redirectToAuthorization() {
    if (this.networkFailed && !this.disconnected) {
      this.transient = true;
      return;
    }
    await this.disconnect();
  }
  saveCodeVerifier() {}
  codeVerifier(): string {
    throw new Error('Not signing in');
  }
  clientInformation() {
    return clientInformation(this.connector, this.connection.client);
  }
  saveAuthorizationServerInformation() {}
  validateAuthorizationServerURL(_serverUrl: string | URL, authorizationServerUrl: string | URL) {
    assertPinnedServer(this.connector, authorizationServerUrl);
  }
  /** The server refused the refresh token or the client: the connection is gone. */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'all' || scope === 'tokens') await this.disconnect();
  }
  private async disconnect() {
    if (this.disconnected) return;
    if (await markDisconnected(this.accountId, 'expired', this.executor, this.storedTokens)) {
      this.disconnected = true;
      return;
    }
    // Replaced meanwhile: use the stored tokens, or stop if they are gone too.
    const [row] = await this.executor
      .select({ encryptedTokens: schema.connectorAccount.encryptedTokens })
      .from(schema.connectorAccount)
      .where(eq(schema.connectorAccount.id, this.accountId))
      .limit(1);
    if (!row?.encryptedTokens) {
      this.disconnected = true;
      return;
    }
    logger.info(
      { connectorId: this.connector.id },
      'Connector tokens were refreshed elsewhere; using those',
    );
    this.storedTokens = row.encryptedTokens;
    this.connection = JSON.parse(decryptSecret(row.encryptedTokens)) as StoredConnection;
  }
}

/** In-process single flight; `refreshLocked` coordinates processes. */
const refreshing = new Map<string, Promise<void>>();

/** "Connect X in Settings" wording for a person without a usable connection. */
export function reconnectMessage(connector: Pick<ConnectorRow, 'name'>): string {
  return `Your ${connector.name} connection has expired or was refused. Connect ${connector.name} again in Settings → Connectors.`;
}

const needsRefresh = (expiresAt: Date | null) =>
  expiresAt !== null && expiresAt.getTime() - REFRESH_MARGIN_MS <= Date.now();

/**
 * Refreshes tokens that are about to expire. Callers in this process share one
 * refresh per account; across processes, `refreshLocked` serializes them.
 * A refresh the server refuses disconnects the account. Returns whether the
 * tokens were (or may have been) replaced, after which they are re-read.
 */
async function ensureFresh(
  connector: ConnectorRow,
  account: ConnectorAccountRow,
): Promise<boolean> {
  if (!needsRefresh(account.expiresAt)) return false;
  let running = refreshing.get(account.id);
  if (!running) {
    running = refreshLocked(connector, account).finally(() => refreshing.delete(account.id));
    refreshing.set(account.id, running);
  }
  await running;
  return true;
}

/**
 * One refresh across every replica: holds the account row with
 * `SELECT … FOR UPDATE` for the duration, and re-reads it once the lock is
 * held. If the tokens changed while waiting, another replica refreshed them
 * and those are used rather than refreshing again, which a server that rotates
 * refresh tokens would refuse. Writes go through the same transaction, so a
 * disconnect is kept even though the caller then gets an error.
 *
 * The lock costs one pooled connection for the length of the refresh. Waiting
 * for it is bounded by the connector time limit; a waiter that gives up is
 * told to try again, and the account is left alone.
 */
async function refreshLocked(connector: ConnectorRow, seen: ConnectorAccountRow): Promise<void> {
  const outcome = await db.transaction(async (tx): Promise<{ error: unknown } | null> => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${String(CONNECTOR_LIMITS.timeoutMs)}, true)`,
    );
    const [row] = await tx
      .select()
      .from(schema.connectorAccount)
      .where(eq(schema.connectorAccount.id, seen.id))
      .for('update');
    if (!row?.encryptedTokens)
      return {
        error: providerError(`Connect ${connector.name} in Settings → Connectors to use it.`),
      };
    if (row.encryptedTokens !== seen.encryptedTokens || !needsRefresh(row.expiresAt)) return null;
    const connection = JSON.parse(decryptSecret(row.encryptedTokens)) as StoredConnection;
    if (!connection.tokens.refresh_token) {
      await markDisconnected(row.id, 'expired', tx);
      return { error: providerError(reconnectMessage(connector)) };
    }
    const provider = new AccountProvider(connector, row.id, connection, row.encryptedTokens, tx);
    try {
      const result = await auth(provider, { serverUrl: connector.url, fetchFn: provider.fetchFn });
      if (provider.transient)
        return {
          error: providerError(
            `Could not renew your ${connector.name} connection. Try again later.`,
          ),
        };
      if (result !== 'AUTHORIZED' || provider.disconnected) {
        if (!provider.disconnected) await markDisconnected(row.id, 'expired', tx);
        return { error: providerError(reconnectMessage(connector)) };
      }
      return null;
    } catch (error) {
      return { error };
    }
  });
  if (outcome) throw outcome.error;
}

/**
 * How to authenticate to a connector for this person: nothing, the shared
 * header, or their own OAuth tokens (refreshed first when about to expire).
 * Only this person's account is ever read.
 */
export async function connectionAuthFor(
  connector: ConnectorRow,
  userId: string,
): Promise<ConnectionAuth> {
  if (connector.authMode === 'none') return {};
  if (connector.authMode === 'shared') {
    if (!connector.encryptedSharedHeaderValue)
      throw providerError(`${connector.name} has no credential set. Ask an administrator.`);
    return {
      headers: {
        [connector.sharedHeaderName]: decryptSecret(connector.encryptedSharedHeaderValue),
      },
    };
  }
  const load = async () => {
    const account = await findAccount(connector.id, userId);
    if (!account?.encryptedTokens)
      throw providerError(`Connect ${connector.name} in Settings → Connectors to use it.`);
    const connection = JSON.parse(decryptSecret(account.encryptedTokens)) as StoredConnection;
    return {
      account,
      provider: new AccountProvider(connector, account.id, connection, account.encryptedTokens),
    };
  };
  let { account, provider } = await load();
  try {
    // A refresh (possibly another call's or replica's) replaced the tokens: use the stored ones.
    if (await ensureFresh(connector, account)) ({ account, provider } = await load());
  } catch (error) {
    if (error instanceof AppError) throw error;
    const network = findNetworkError(error);
    throw providerError(
      network
        ? `${connector.name} could not be used. ${network.message}`
        : `Could not renew your ${connector.name} connection. Try again later.`,
    );
  }
  return { authProvider: provider, reconnectMessage: reconnectMessage(connector) };
}

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

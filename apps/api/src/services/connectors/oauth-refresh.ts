import { auth, type OAuthClientProvider, type OAuthTokens } from '@ai-sdk/mcp';
import { eq, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { decryptSecret } from '../../lib/crypto.js';
import { AppError, providerError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type ConnectionAuth, connectorFetch } from './client.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { findNetworkError } from './network.js';
import {
  assertPinnedServer,
  clientInformation,
  clientMetadata,
  oauthRedirectUrl,
} from './oauth-client.js';
import {
  type Executor,
  markDisconnected,
  type StoredConnection,
  saveConnection,
} from './oauth-tokens.js';
import { type ConnectorAccountRow, type ConnectorRow, findAccount } from './store.js';

/** Tokens this close to expiry are refreshed before a call. */
const REFRESH_MARGIN_MS = 60_000;

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

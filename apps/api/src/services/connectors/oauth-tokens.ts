import type { OAuthTokens } from '@ai-sdk/mcp';
import { and, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { encryptSecret } from '../../lib/crypto.js';
import type { StoredClient } from './oauth-client.js';

type AccountTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Where an account's writes go: the pool, or the transaction holding its row lock. */
export type Executor = typeof db | AccountTransaction;

export interface StoredConnection {
  tokens: OAuthTokens;
  client: StoredClient;
}

const expiryOf = (tokens: OAuthTokens) =>
  typeof tokens.expires_in === 'number' && tokens.expires_in > 0
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;

/** Stores a connection and returns its ciphertext, which identifies this version of the tokens. */
export async function saveConnection(
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
 * Forgets a person's tokens and records why, so Settings can ask them to
 * reconnect. With `onlyTokens`, only if those are still the stored tokens:
 * returns false when another refresh replaced them meanwhile.
 */
export async function markDisconnected(
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

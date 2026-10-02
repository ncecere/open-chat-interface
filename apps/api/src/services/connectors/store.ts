import { and, eq, isNotNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

export type ConnectorRow = typeof schema.connector.$inferSelect;
export type ConnectorToolRow = typeof schema.connectorTool.$inferSelect;
export type ConnectorAccountRow = typeof schema.connectorAccount.$inferSelect;

export async function findConnector(id: string): Promise<ConnectorRow | null> {
  const [row] = await db
    .select()
    .from(schema.connector)
    .where(eq(schema.connector.id, id))
    .limit(1);
  return row ?? null;
}

export async function findAccount(
  connectorId: string,
  userId: string,
): Promise<ConnectorAccountRow | null> {
  const [row] = await db
    .select()
    .from(schema.connectorAccount)
    .where(
      and(
        eq(schema.connectorAccount.connectorId, connectorId),
        eq(schema.connectorAccount.userId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Connectors this person has a live OAuth connection to. */
export async function connectedConnectorIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ connectorId: schema.connectorAccount.connectorId })
    .from(schema.connectorAccount)
    .where(
      and(
        eq(schema.connectorAccount.userId, userId),
        isNotNull(schema.connectorAccount.encryptedTokens),
      ),
    );
  return new Set(rows.map((row) => row.connectorId));
}

/** Notes a successful exchange, for the Connectors and System health pages. */
export function recordContact(connectorId: string): void {
  void db
    .update(schema.connector)
    .set({ lastContactAt: new Date() })
    .where(eq(schema.connector.id, connectorId))
    .catch((error) =>
      logger.warn({ err: error, connectorId }, 'Could not record connector contact'),
    );
}

/** Notes a failure with the same safe wording people see; never a credential or response body. */
export function recordFailure(connectorId: string, message: string): void {
  void db
    .update(schema.connector)
    .set({ lastError: message.slice(0, 300), lastErrorAt: new Date() })
    .where(eq(schema.connector.id, connectorId))
    .catch((error) =>
      logger.warn({ err: error, connectorId }, 'Could not record connector failure'),
    );
}

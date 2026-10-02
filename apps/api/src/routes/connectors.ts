import { startConnectorConnectSchema } from '@oci/shared';
import { Hono } from 'hono';
import { loadEnv } from '../config/env.js';
import { notFound } from '../lib/errors.js';
import { type AppBindings, currentUser } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import {
  ConnectorOAuthError,
  type ConnectReturn,
  completeConnect,
  disconnectAccount,
  startConnect,
} from '../services/connectors/oauth.js';
import { connectableConnector, userConnectors } from '../services/connectors/people.js';
import { findConnector } from '../services/connectors/store.js';

export const connectorRoutes = new Hono<AppBindings>();

/** Where a finished or refused sign-in lands, with the outcome in the query string. */
function returnUrl(returnTo: ConnectReturn, params: Record<string, string>): string {
  const url = new URL(
    returnTo === 'admin' ? '/admin/connectors' : '/settings/connectors',
    loadEnv().APP_URL,
  );
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Lists the OAuth connectors the signed-in person may use, and whether each is connected. */
connectorRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json({ connectors: await userConnectors(user) });
});

/** Starts connecting the signed-in person's account and returns the sign-in URL to open. */
connectorRoutes.post('/:id/connect', async (c) => {
  const user = currentUser(c);
  const { returnTo } = await parseBody(c, startConnectorConnectSchema);
  const connector = await connectableConnector(user, c.req.param('id'));
  const authorizationUrl = await startConnect(user.id, connector, returnTo);
  return c.json({ authorizationUrl });
});

/**
 * Receives the authorization server's redirect. The state must belong to the
 * signed-in person's own unexpired attempt; the outcome is shown on the page
 * the attempt started from.
 */
connectorRoutes.get('/oauth/callback', async (c) => {
  const user = c.get('user');
  if (!user) return c.redirect(returnUrl('settings', { error: 'signed-out' }));
  try {
    const { connector, returnTo } = await completeConnect(user.id, {
      state: c.req.query('state'),
      code: c.req.query('code'),
      error: c.req.query('error'),
    });
    await recordAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'connector.account.connect',
      targetType: 'connector',
      targetId: connector.id,
      metadata: { connector: connector.slug },
    });
    return c.redirect(returnUrl(returnTo, { connected: connector.slug }));
  } catch (error) {
    const code = error instanceof ConnectorOAuthError ? error.code : 'failed';
    return c.redirect(returnUrl('settings', { error: code }));
  }
});

/** Disconnects the signed-in person: deletes their tokens and asks the server to revoke them. */
connectorRoutes.delete('/:id/account', async (c) => {
  const user = currentUser(c);
  const connector = await findConnector(c.req.param('id'));
  if (!connector) throw notFound('Connector not found');
  const result = await disconnectAccount(user.id, connector);
  if (!result.existed) throw notFound('You are not connected to this connector');
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'connector.account.disconnect',
    targetType: 'connector',
    targetId: connector.id,
    metadata: { connector: connector.slug, revoked: result.revoked },
  });
  return c.json({ ok: true, revoked: result.revoked });
});

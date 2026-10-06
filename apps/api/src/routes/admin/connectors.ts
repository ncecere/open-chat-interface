import {
  createConnectorSchema,
  updateConnectorSchema,
  updateConnectorToolSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import {
  createConnector,
  deleteConnector,
  getAdminConnector,
  listConnectors,
  loadConnectorOrThrow,
  refreshConnectorTools,
  testConnector,
  updateConnector,
  updateConnectorTool,
} from '../../services/connectors/admin.js';
import { addUrlIssue } from '../../services/connectors/network.js';
import { diffUpdate } from '../../services/settings-diff.js';

export const connectorRoutes = new Hono<AppBindings>();

/** Lists every connector with its tools; secrets are reported only as set or not set. */
connectorRoutes.get('/', async (c) => c.json({ connectors: await listConnectors() }));

/** Returns one connector with its tools. */
connectorRoutes.get('/:id', async (c) => c.json(await getAdminConnector(c.req.param('id'))));

/** Registers an MCP server. Its tools are listed with "Refresh tools" and start disabled. */
connectorRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  // The URL's network rules are checked with the rest of the body, so every
  // problem is reported at once (#283).
  const input = await parseBody(
    c,
    createConnectorSchema.superRefine((body, ctx) =>
      addUrlIssue(ctx, body.url, { allowPrivateNetwork: body.allowPrivateNetwork }),
    ),
  );
  const created = await createConnector(input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.create',
    targetType: 'connector',
    targetId: created.id,
    metadata: {
      name: created.name,
      slug: created.slug,
      authMode: created.authMode,
      allowPrivateNetwork: created.allowPrivateNetwork,
      credential: input.sharedHeaderValue ? 'set' : 'none',
      oauthClientSecret: input.oauthClientSecret ? 'set' : 'none',
    },
  });
  return c.json(await getAdminConnector(created.id), 201);
});

/** The settings a connector edit records as they were and became; no secrets. */
const CONNECTOR_AUDITED_FIELDS = [
  'name',
  'url',
  'authMode',
  'sharedHeaderName',
  'oauthScopes',
  'oauthClientId',
  'enabled',
  'allowPrivateNetwork',
] as const;

/**
 * Changes a connector; only sent fields change. Changing its address,
 * authentication mode or OAuth client disconnects everyone connected to it.
 */
connectorRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  // Checked against what the connector becomes, with the rest of the body,
  // so every problem is reported at once (#283); updateConnector checks again.
  const input = await parseBody(
    c,
    updateConnectorSchema.superRefine((body, ctx) => {
      addUrlIssue(ctx, body.url ?? existing.url, {
        allowPrivateNetwork: body.allowPrivateNetwork ?? existing.allowPrivateNetwork,
      });
      const credential =
        body.sharedHeaderValue === undefined
          ? existing.encryptedSharedHeaderValue
          : body.sharedHeaderValue;
      if ((body.authMode ?? existing.authMode) === 'shared' && !credential)
        ctx.addIssue({
          code: 'custom',
          path: ['sharedHeaderValue'],
          message: 'Enter the credential OCI sends to this server.',
        });
    }),
  );
  const result = await updateConnector(existing, input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.update',
    targetType: 'connector',
    targetId: existing.id,
    // Which fields changed, as they were and became (#258); never a
    // credential, only whether it was replaced or cleared.
    metadata: {
      slug: existing.slug,
      fields: result.fields,
      changes: diffUpdate(existing, result.row, CONNECTOR_AUDITED_FIELDS),
      ...result.credentials,
      accountsRemoved: result.accountsRemoved,
    },
  });
  return c.json(await getAdminConnector(existing.id));
});

/** Deletes a connector with its tools, everyone's connections and its role allows. */
connectorRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  const removed = await deleteConnector(existing);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.delete',
    targetType: 'connector',
    targetId: existing.id,
    metadata: { name: existing.name, slug: existing.slug, ...removed },
  });
  return c.json({ ok: true });
});

/** Checks that the server answers the MCP handshake and lists its tools. */
connectorRoutes.post('/:id/test', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  const result = await testConnector(existing, actor.id);
  // It connects to an address an administrator chose, so it is audited as
  // every other Test button is (#287).
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.test',
    targetType: 'connector',
    targetId: existing.id,
    metadata: { slug: existing.slug, url: existing.url, ok: result.ok },
  });
  return c.json(result);
});

/** Lists the server's tools and stores them; new tools start disabled, vanished ones are marked missing. */
connectorRoutes.post('/:id/refresh', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  const result = await refreshConnectorTools(existing, actor.id);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.tools.refresh',
    targetType: 'connector',
    targetId: existing.id,
    metadata: {
      slug: existing.slug,
      added: result.added,
      updated: result.updated,
      missing: result.missing,
    },
  });
  return c.json(result);
});

/**
 * Switches one connector tool on or off, or changes its kind. Marking a tool
 * `read` that the server does not declare read-only needs `confirmReadOnly`.
 */
connectorRoutes.patch('/:id/tools/:toolId', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  const input = await parseBody(c, updateConnectorToolSchema);
  const result = await updateConnectorTool(existing, c.req.param('toolId'), input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.tool.update',
    targetType: 'connector_tool',
    targetId: result.tool.id,
    metadata: {
      slug: existing.slug,
      toolId: result.tool.toolId,
      changes: result.changes,
      ...(input.confirmReadOnly && result.changes.kind ? { readOnlyConfirmed: true } : {}),
    },
  });
  return c.json(result.tool);
});

import {
  createConnectorSchema,
  setConnectorDataClassesSchema,
  updateConnectorSchema,
  updateConnectorToolSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { auditedAddress, failedReason } from '../../services/audit-test-details.js';
import { classificationMode } from '../../services/classification/config.js';
import { namesOf, setConnectorClasses } from '../../services/classification/store.js';
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
  // With classification on, a new connector must say what it carries, or that
  // it carries nothing: an unlabelled connector is unaffected by decision, so
  // forgetting to label it would fail open (#395).
  if (
    (await classificationMode()) !== 'off' &&
    input.dataClassIds === undefined &&
    input.reviewed !== true
  )
    throw validationFailed(
      'Say which data classes this connector carries, or that it carries none.',
      [
        {
          path: ['dataClassIds'],
          message: 'Choose the classes it carries, or confirm that it carries no classified data.',
        },
      ],
    );
  const created = await createConnector(input);
  if (input.dataClassIds !== undefined || input.reviewed)
    await setConnectorClasses(created.id, input.dataClassIds ?? [], input.reviewed ?? false);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.create',
    targetType: 'connector',
    targetId: created.id,
    metadata: {
      name: created.name,
      slug: created.slug,
      // Where it connects, without credentials or query (#374): as
      // `connector.update` and `connector.test` record it.
      url: auditedAddress(created.url),
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

/**
 * What the connector carries (v0.14, #395): the whole list is replaced, and
 * `reviewed` says someone looked, even if it carries nothing. Conversations that
 * used it earlier take the new classes at once (they are read at decision time).
 */
connectorRoutes.put('/:id/data-classes', async (c) => {
  const actor = currentUser(c);
  const existing = await loadConnectorOrThrow(c.req.param('id'));
  const input = await parseBody(c, setConnectorDataClassesSchema);
  const result = await setConnectorClasses(existing.id, input.classIds, input.reviewed);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'connector.data_classes.update',
    targetType: 'connector',
    targetId: existing.id,
    metadata: {
      slug: existing.slug,
      before: await namesOf(result.before),
      after: await namesOf(result.after),
      reviewed: result.reviewed,
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
    // A failure says why: "could not be reached" and "answered, but not as an
    // MCP server" read differently on the page and must in the log (#368).
    metadata: {
      slug: existing.slug,
      url: auditedAddress(existing.url),
      ok: result.ok,
      ...failedReason(result, result.detail),
    },
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

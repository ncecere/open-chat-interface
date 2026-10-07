import { and, count, desc, eq, schema } from '@oci/db';
import {
  capacityLimitsSchema,
  type Provider,
  updateCapacityQueueSchema,
  updateProviderSchema,
  upsertProviderSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { credentialHint, decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { auditedAddress } from '../../services/audit-test-details.js';
import { capacityOverview } from '../../services/limits/capacity/overview.js';
import { saveProviderLimits, saveQueueSettings } from '../../services/limits/capacity/settings.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import {
  applyProviderPatch,
  getProviderConfigurationIssues,
  withConfigurationIssues,
} from '../../services/providers/config.js';
import { discoverModels } from '../../services/providers/registry.js';

export const providerRoutes = new Hono<AppBindings>();

async function loadProviderOrThrow(id: string) {
  const [row] = await db.select().from(schema.provider).where(eq(schema.provider.id, id)).limit(1);
  if (!row) throw notFound('Provider not found');
  return row;
}

providerRoutes.get('/', async (c) => {
  const rows = await db
    .select({
      id: schema.provider.id,
      kind: schema.provider.kind,
      label: schema.provider.label,
      baseUrl: schema.provider.baseUrl,
      enabled: schema.provider.enabled,
      encryptedApiKey: schema.provider.encryptedApiKey,
      credentialHint: schema.provider.credentialHint,
      createdAt: schema.provider.createdAt,
      updatedAt: schema.provider.updatedAt,
    })
    .from(schema.provider)
    .orderBy(desc(schema.provider.createdAt));

  const counts = await db
    .select({ providerId: schema.model.providerId, value: count() })
    .from(schema.model)
    .groupBy(schema.model.providerId);

  const countByProvider = new Map(counts.map((row) => [row.providerId, row.value]));

  const providers: Provider[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    hasCredential: Boolean(row.encryptedApiKey),
    credentialHint: row.credentialHint,
    modelCount: countByProvider.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return c.json({ providers });
});

/**
 * Provider capacity (v0.11): limits, queue settings, and each provider's
 * queue now. Registered before `/:id` routes.
 */
providerRoutes.get('/capacity', async (c) => c.json(await capacityOverview()));

providerRoutes.put('/capacity', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateCapacityQueueSchema);
  const queue = await saveQueueSettings(input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.capacity.queue',
    targetType: 'setting',
    targetId: 'providerCapacity',
    metadata: { ...queue },
  });
  return c.json({ queue });
});

providerRoutes.put('/:id/capacity', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  await loadProviderOrThrow(id);
  const limits = await parseBody(c, capacityLimitsSchema);
  await saveProviderLimits(id, limits);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.capacity',
    targetType: 'provider',
    targetId: id,
    metadata: { ...limits },
  });
  return c.json({ limits });
});

providerRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  // The configuration rules are checked with the body's schema, so a bad
  // base URL and a missing key are refused together (#283).
  const input = await parseBody(
    c,
    withConfigurationIssues(upsertProviderSchema, (body) =>
      body.kind
        ? {
            kind: body.kind,
            label: body.label ?? '',
            baseUrl: body.baseUrl ?? null,
            enabled: body.enabled ?? true,
            encryptedApiKey: body.apiKey ? 'provided' : null,
            credentialHint: null,
          }
        : null,
    ),
  );
  const organizationId = await getDefaultOrganizationId();

  const issues = getProviderConfigurationIssues({
    kind: input.kind,
    label: input.label,
    baseUrl: input.baseUrl ?? null,
    enabled: input.enabled,
    // Only whether a key was given matters here; it is encrypted below.
    encryptedApiKey: input.apiKey ? 'provided' : null,
    credentialHint: null,
  });
  if (issues.length > 0) {
    throw validationFailed(
      'Complete the required provider settings.',
      issues.map((issue) => ({ path: [issue.field], message: issue.message })),
    );
  }

  const [created] = await db
    .insert(schema.provider)
    .values({
      organizationId,
      kind: input.kind,
      label: input.label,
      baseUrl: input.baseUrl ?? null,
      enabled: input.enabled,
      encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : null,
      credentialHint: input.apiKey ? credentialHint(input.apiKey) : null,
    })
    .returning({ id: schema.provider.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.create',
    targetType: 'provider',
    targetId: created?.id ?? null,
    // Its address and state too, as `provider.delete` records them (#374).
    metadata: {
      kind: input.kind,
      label: input.label,
      baseUrl: auditedAddress(input.baseUrl),
      enabled: input.enabled,
    },
  });

  return c.json({ id: created?.id }, 201);
});

providerRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const existing = await loadProviderOrThrow(id);

  // Checked against what the provider would become, with the body's schema,
  // so every problem is refused at once (#283).
  const input = await parseBody(
    c,
    withConfigurationIssues(updateProviderSchema, (body) =>
      applyProviderPatch(
        existing,
        body,
        () => 'provided',
        () => '',
      ),
    ),
  );
  const next = applyProviderPatch(existing, input, encryptSecret, credentialHint);

  // Catalog entries are bound to a provider's wire protocol, so switching kind
  // underneath them would silently break every model that already resolves here.
  if (next.kind !== existing.kind) {
    const [models] = await db
      .select({ value: count() })
      .from(schema.model)
      .where(eq(schema.model.providerId, id));

    if ((models?.value ?? 0) > 0) {
      throw validationFailed(
        'Remove this provider’s catalog models before changing its provider type.',
      );
    }
  }

  const issues = getProviderConfigurationIssues(next);
  if (issues.length > 0) {
    throw validationFailed(
      'Complete the required provider settings.',
      issues.map((issue) => ({ path: [issue.field], message: issue.message })),
    );
  }

  const [updated] = await db
    .update(schema.provider)
    .set({
      kind: next.kind,
      label: next.label,
      baseUrl: next.baseUrl,
      enabled: next.enabled,
      encryptedApiKey: next.encryptedApiKey,
      credentialHint: next.credentialHint,
    })
    .where(eq(schema.provider.id, id))
    .returning({ id: schema.provider.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.update',
    targetType: 'provider',
    targetId: id,
    // Record which fields changed, never the credential itself.
    metadata: {
      fields: Object.keys(input).filter((key) => key !== 'apiKey'),
      credential:
        input.apiKey === null ? 'cleared' : input.apiKey?.trim() ? 'replaced' : 'unchanged',
    },
  });

  return c.json({ id: updated?.id });
});

providerRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const provider = await loadProviderOrThrow(id);

  // Its models go with it (cascade); refuse rather than remove the default.
  const [defaultModel] = await db
    .select({ displayName: schema.model.displayName })
    .from(schema.model)
    .where(and(eq(schema.model.providerId, id), eq(schema.model.isDefault, true)))
    .limit(1);
  if (defaultModel) {
    throw conflict(
      `This provider supplies the default model, ${defaultModel.displayName}. Make a model from another provider the default first, then delete this provider.`,
    );
  }

  await db.delete(schema.provider).where(eq(schema.provider.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.delete',
    targetType: 'provider',
    targetId: id,
    // The row is gone, so the entry says what it was (never the key).
    metadata: { label: provider.label, kind: provider.kind, baseUrl: provider.baseUrl },
  });

  return c.json({ ok: true });
});

/** Lists models the credential can reach; none are exposed until curated. */
providerRoutes.post('/:id/discover', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const row = await loadProviderOrThrow(id);

  const discovered = await discoverModels({
    kind: row.kind,
    label: row.label,
    apiKey: row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : null,
    baseUrl: row.baseUrl,
  });

  const existing = await db
    .select({ upstreamModelId: schema.model.upstreamModelId })
    .from(schema.model)
    .where(eq(schema.model.providerId, id));

  const known = new Set(existing.map((entry) => entry.upstreamModelId));

  // Discovery uses the stored credential against an external service.
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.discover',
    targetType: 'provider',
    targetId: id,
    metadata: { discovered: discovered.length },
  });

  return c.json({
    models: discovered.map((entry) => ({
      upstreamModelId: entry.id,
      displayName: entry.displayName,
      alreadyInCatalog: known.has(entry.id),
    })),
  });
});

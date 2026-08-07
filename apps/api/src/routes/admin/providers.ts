import { count, desc, eq, schema } from '@oci/db';
import { type Provider, upsertProviderSchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { credentialHint, decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
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

providerRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertProviderSchema);
  const organizationId = await getDefaultOrganizationId();

  if (input.kind === 'openai-compatible' && !input.baseUrl) {
    throw validationFailed('OpenAI-compatible providers require a base URL');
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
    metadata: { kind: input.kind, label: input.label },
  });

  return c.json({ id: created?.id }, 201);
});

providerRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  await loadProviderOrThrow(id);

  const input = await parseBody(c, upsertProviderSchema.partial());

  const [updated] = await db
    .update(schema.provider)
    .set({
      ...(input.label !== undefined && { label: input.label }),
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl ?? null }),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.apiKey !== undefined && {
        encryptedApiKey: encryptSecret(input.apiKey),
        credentialHint: credentialHint(input.apiKey),
      }),
    })
    .where(eq(schema.provider.id, id))
    .returning({ id: schema.provider.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.update',
    targetType: 'provider',
    targetId: id,
    metadata: { fields: Object.keys(input).filter((key) => key !== 'apiKey') },
  });

  return c.json({ id: updated?.id });
});

providerRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  await loadProviderOrThrow(id);

  await db.delete(schema.provider).where(eq(schema.provider.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'provider.delete',
    targetType: 'provider',
    targetId: id,
  });

  return c.json({ ok: true });
});

/** Lists models the credential can reach; none are exposed until curated. */
providerRoutes.post('/:id/discover', async (c) => {
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

  return c.json({
    models: discovered.map((entry) => ({
      upstreamModelId: entry.id,
      displayName: entry.displayName,
      alreadyInCatalog: known.has(entry.id),
    })),
  });
});

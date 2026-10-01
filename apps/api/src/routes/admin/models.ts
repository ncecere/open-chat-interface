import { and, asc, eq, ne, schema } from '@oci/db';
import { type AdminModel, updateModelSchema, upsertModelSchema } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';

export const modelRoutes = new Hono<AppBindings>();

modelRoutes.get('/', async (c) => {
  const rows = await db
    .select({
      model: schema.model,
      providerKind: schema.provider.kind,
      providerLabel: schema.provider.label,
    })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName));

  const models: AdminModel[] = rows.map(({ model, providerKind, providerLabel }) => ({
    id: model.id,
    slug: model.slug,
    displayName: model.displayName,
    description: model.description,
    providerId: model.providerId,
    providerKind,
    providerLabel,
    labId: model.labId,
    upstreamModelId: model.upstreamModelId,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportedEfforts: model.supportedEfforts,
    inputPriceMicros: model.inputPriceMicros === null ? null : Number(model.inputPriceMicros),
    outputPriceMicros: model.outputPriceMicros === null ? null : Number(model.outputPriceMicros),
    isDefault: model.isDefault,
    sortOrder: model.sortOrder,
    enabled: model.enabled,
    visibleToRoles: model.visibleToRoles,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  }));

  return c.json({ models });
});

type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * Serializes default-model changes for an organization. Taken before the
 * write, so two concurrent "make default" requests cannot both commit with
 * their own model marked default; the later one clears the earlier.
 */
async function lockCatalog(tx: Executor, organizationId: string) {
  await tx
    .select({ id: schema.model.id })
    .from(schema.model)
    .where(eq(schema.model.organizationId, organizationId))
    .for('update');
}

async function clearOtherDefaults(tx: Executor, organizationId: string, keepId: string) {
  await tx
    .update(schema.model)
    .set({ isDefault: false })
    .where(and(eq(schema.model.organizationId, organizationId), ne(schema.model.id, keepId)));
}

async function requireProvider(providerId: string, organizationId: string) {
  const [provider] = await db
    .select({ id: schema.provider.id })
    .from(schema.provider)
    .where(
      and(eq(schema.provider.id, providerId), eq(schema.provider.organizationId, organizationId)),
    )
    .limit(1);

  if (!provider) throw notFound('Provider not found');
}

modelRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertModelSchema);
  const organizationId = await getDefaultOrganizationId();
  await requireProvider(input.providerId, organizationId);

  const [existing] = await db
    .select({ id: schema.model.id })
    .from(schema.model)
    .where(eq(schema.model.slug, input.slug))
    .limit(1);

  if (existing) throw conflict('A model with that slug already exists');

  const created = await db.transaction(async (tx) => {
    if (input.isDefault) await lockCatalog(tx, organizationId);
    const [row] = await tx
      .insert(schema.model)
      .values({
        organizationId,
        providerId: input.providerId,
        slug: input.slug,
        labId: input.labId ?? null,
        upstreamModelId: input.upstreamModelId,
        displayName: input.displayName,
        description: input.description ?? null,
        capabilities: input.capabilities,
        contextWindow: input.contextWindow ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        supportedEfforts: input.supportedEfforts,
        inputPriceMicros: input.inputPriceMicros ?? null,
        outputPriceMicros: input.outputPriceMicros ?? null,
        visibleToRoles: input.visibleToRoles,
        enabled: input.enabled,
        isDefault: input.isDefault,
        sortOrder: input.sortOrder,
      })
      .returning({ id: schema.model.id });
    if (input.isDefault && row) await clearOtherDefaults(tx, organizationId, row.id);
    return row;
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'model.create',
    targetType: 'model',
    targetId: created?.id ?? null,
    metadata: { slug: input.slug, upstreamModelId: input.upstreamModelId },
  });

  return c.json({ id: created?.id }, 201);
});

modelRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  const [existing] = await db
    .select({ id: schema.model.id, organizationId: schema.model.organizationId })
    .from(schema.model)
    .where(eq(schema.model.id, id))
    .limit(1);

  if (!existing) throw notFound('Model not found');

  const input = await parseBody(c, updateModelSchema);
  const organizationId = await getDefaultOrganizationId();

  if (input.providerId !== undefined) await requireProvider(input.providerId, organizationId);
  if (input.slug !== undefined) {
    const [slugOwner] = await db
      .select({ id: schema.model.id })
      .from(schema.model)
      .where(
        and(
          eq(schema.model.organizationId, organizationId),
          eq(schema.model.slug, input.slug),
          ne(schema.model.id, id),
        ),
      )
      .limit(1);
    if (slugOwner) throw conflict('A model with that slug already exists');
  }

  const updated = await db.transaction(async (tx) => {
    if (input.isDefault) await lockCatalog(tx, organizationId);
    const [row] = await tx
      .update(schema.model)
      .set({
        ...(input.providerId !== undefined && { providerId: input.providerId }),
        ...(input.slug !== undefined && { slug: input.slug }),
        ...(input.labId !== undefined && { labId: input.labId ?? null }),
        ...(input.upstreamModelId !== undefined && { upstreamModelId: input.upstreamModelId }),
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.description !== undefined && { description: input.description ?? null }),
        ...(input.capabilities !== undefined && { capabilities: input.capabilities }),
        ...(input.contextWindow !== undefined && { contextWindow: input.contextWindow ?? null }),
        ...(input.maxOutputTokens !== undefined && {
          maxOutputTokens: input.maxOutputTokens ?? null,
        }),
        ...(input.supportedEfforts !== undefined && { supportedEfforts: input.supportedEfforts }),
        ...(input.inputPriceMicros !== undefined && {
          inputPriceMicros: input.inputPriceMicros ?? null,
        }),
        ...(input.outputPriceMicros !== undefined && {
          outputPriceMicros: input.outputPriceMicros ?? null,
        }),
        ...(input.visibleToRoles !== undefined && { visibleToRoles: input.visibleToRoles }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
      })
      .where(eq(schema.model.id, id))
      .returning({ id: schema.model.id });
    if (input.isDefault) await clearOtherDefaults(tx, organizationId, id);
    return row;
  });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'model.update',
    targetType: 'model',
    targetId: id,
    metadata: { fields: Object.keys(input) },
  });

  return c.json({ id: updated?.id });
});

modelRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  await db.delete(schema.model).where(eq(schema.model.id, id));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'model.delete',
    targetType: 'model',
    targetId: id,
  });

  return c.json({ ok: true });
});

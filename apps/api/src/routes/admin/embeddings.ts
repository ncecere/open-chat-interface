import { eq, schema } from '@oci/db';
import {
  type EmbeddingsSettings,
  type EmbeddingsTestResult,
  embeddingsTestSchema,
  providerCanEmbed,
  updateEmbeddingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { embeddingsSettings, isActive } from '../../services/embeddings/config.js';
import { testEmbeddingModel } from '../../services/embeddings/embed.js';
import { embeddingsStatus } from '../../services/embeddings/status.js';
import { ensureEmbeddingTable, pgvectorInfo } from '../../services/embeddings/storage.js';
import { updateSetting } from '../../services/settings.js';

/**
 * Meaning-based search for project files: the embeddings model (an existing
 * provider and a model id) and the state of pgvector. Reads are open to
 * auditors; every change is audited.
 */
export const embeddingsRoutes = new Hono<AppBindings>();

/** Words for an administrator; provider errors can be long. */
function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown error';
  return `The model could not embed a sample: ${detail}`.slice(0, 500);
}

/** The embeddings setting, pgvector's state and indexing progress; the provider key is never returned. */
embeddingsRoutes.get('/', async (c) => c.json(await embeddingsStatus()));

/**
 * Saves the setting. Choosing a model (or switching meaning-based search on
 * without known dimensions) embeds a sample first: its length is the vector
 * size. A model that cannot embed cannot be switched on. With pgvector
 * enabled, switching on creates the storage straight away; otherwise the
 * background job creates it once the extension is enabled.
 */
embeddingsRoutes.put('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateEmbeddingsSchema);
  const previous = await embeddingsSettings({ fresh: true });
  const next: EmbeddingsSettings = {
    ...previous,
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.providerId !== undefined && { providerId: input.providerId }),
    ...(input.modelId !== undefined && { modelId: input.modelId }),
    ...(input.inputPriceMicros !== undefined && { inputPriceMicros: input.inputPriceMicros }),
  };

  if (next.providerId && next.providerId !== previous.providerId) {
    const [provider] = await db
      .select({ kind: schema.provider.kind })
      .from(schema.provider)
      .where(eq(schema.provider.id, next.providerId))
      .limit(1);
    if (!provider) throw validationFailed('That provider does not exist.');
    if (!providerCanEmbed(provider.kind)) {
      throw validationFailed('That provider cannot create embeddings.');
    }
  }
  if (next.enabled && (!next.providerId || !next.modelId)) {
    throw validationFailed('Choose a provider and a model before turning meaning-based search on.');
  }

  const modelChanged = next.providerId !== previous.providerId || next.modelId !== previous.modelId;
  if (modelChanged) next.dimensions = null;
  if (next.providerId && next.modelId && (modelChanged || (next.enabled && !next.dimensions))) {
    try {
      next.dimensions = (await testEmbeddingModel(next)).dimensions;
    } catch (error) {
      if (next.enabled) throw validationFailed(failureMessage(error));
      next.dimensions = null;
    }
  }

  await updateSetting('embeddings', next);

  let storage: string | null = null;
  if (isActive(next) && (await pgvectorInfo()).state === 'enabled') {
    try {
      storage = await ensureEmbeddingTable(next.dimensions);
    } catch (error) {
      // The job retries; the setting itself is saved.
      logger.warn({ error }, 'Creating embedding storage failed');
    }
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'embeddings.update',
    targetType: 'instance',
    metadata: {
      previous: {
        enabled: previous.enabled,
        providerId: previous.providerId,
        modelId: previous.modelId,
        dimensions: previous.dimensions,
        inputPriceMicros: previous.inputPriceMicros,
      },
      next: {
        enabled: next.enabled,
        providerId: next.providerId,
        modelId: next.modelId,
        dimensions: next.dimensions,
        inputPriceMicros: next.inputPriceMicros,
      },
      ...(storage && { storage }),
    },
  });
  return c.json(await embeddingsStatus());
});

/** Embeds a sample with the model on the page (or the saved one). Nothing is stored. */
embeddingsRoutes.post('/test', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, embeddingsTestSchema);
  const saved = await embeddingsSettings();
  const target = {
    providerId: input.providerId ?? saved.providerId,
    modelId: input.modelId ?? saved.modelId,
  };
  let result: EmbeddingsTestResult;
  try {
    result = { ok: true, dimensions: (await testEmbeddingModel(target)).dimensions };
  } catch (error) {
    result = { ok: false, message: failureMessage(error) };
  }
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'embeddings.test',
    targetType: 'instance',
    metadata: { ...target, ok: result.ok, ...(result.ok && { dimensions: result.dimensions }) },
  });
  return c.json(result);
});

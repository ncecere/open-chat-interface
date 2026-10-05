import { eq, schema } from '@oci/db';
import {
  type EmbeddingsSettings,
  type EmbeddingsTestResult,
  embeddingCostMicros,
  embeddingsSwitchSchema,
  embeddingsTestSchema,
  providerCanEmbed,
  updateEmbeddingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { embeddingsSettings } from '../../services/embeddings/config.js';
import { testEmbeddingModel } from '../../services/embeddings/embed.js';
import {
  applyModelChoice,
  cancelRebuild,
  desiredSettings,
  EMBEDDINGS_REBUILD_JOB,
  SwitchBlockedError,
  switchGeneration,
} from '../../services/embeddings/generations.js';
import { embeddingsStatus, passageEstimate } from '../../services/embeddings/status.js';
import { kickJob } from '../../services/jobs/requests.js';
import { GenerationStateError } from '../../services/vector-store/index.js';

/**
 * Meaning-based search for project files: the embeddings model (an existing
 * provider and a model id), the state of pgvector, and embedding generations
 * (v0.11): changing the model rebuilds in the background while searches keep
 * using the current model, then switches. Reads are open to auditors; every
 * change is audited.
 */
export const embeddingsRoutes = new Hono<AppBindings>();

/** Words for an administrator; provider errors can be long. */
function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown error';
  return `The model could not embed a sample: ${detail}`.slice(0, 500);
}

function auditedSettings(settings: EmbeddingsSettings) {
  return {
    enabled: settings.enabled,
    providerId: settings.providerId,
    modelId: settings.modelId,
    dimensions: settings.dimensions,
    inputPriceMicros: settings.inputPriceMicros,
  };
}

/** The embeddings setting, pgvector's state, generations and progress; the provider key is never returned. */
embeddingsRoutes.get('/', async (c) => c.json(await embeddingsStatus()));

/**
 * Saves the setting. Choosing a model (or switching meaning-based search on
 * without known dimensions) embeds a sample first: its length is the vector
 * size. A model that cannot embed cannot be switched on, nor replace a model
 * already in use. A new model starts a rebuild: a new generation filled in the
 * background, which searches move to once it covers every passage.
 */
embeddingsRoutes.put('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateEmbeddingsSchema);
  const { settings: previous, current } = await desiredSettings();
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
  if (current && (!next.providerId || !next.modelId)) {
    throw validationFailed(
      'Embeddings are stored for a model already. Turn meaning-based search off instead of removing the model.',
    );
  }

  const modelChanged = next.providerId !== previous.providerId || next.modelId !== previous.modelId;
  if (modelChanged) next.dimensions = null;
  if (next.providerId && next.modelId && (modelChanged || (next.enabled && !next.dimensions))) {
    try {
      next.dimensions = (await testEmbeddingModel(next)).dimensions;
    } catch (error) {
      // Without its size a model cannot have storage, so it cannot replace one in use.
      if (next.enabled || current) throw validationFailed(failureMessage(error));
      next.dimensions = null;
    }
  }

  const estimate = modelChanged ? await passageEstimate() : null;
  const choice = await applyModelChoice(next, actor.id);
  if (choice.rebuild === 'started' || choice.rebuild === 'replaced') {
    kickJob(EMBEDDINGS_REBUILD_JOB);
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'embeddings.update',
    targetType: 'instance',
    metadata: {
      previous: auditedSettings(previous),
      next: auditedSettings(next),
      ...(choice.storage && { storage: choice.storage }),
      ...(choice.rebuild && {
        rebuild: choice.rebuild,
        generation: choice.rebuild === 'cancelled' ? choice.current?.id : choice.filling?.id,
      }),
      ...(estimate &&
        (choice.rebuild === 'started' || choice.rebuild === 'replaced') && {
          estimate: {
            ...estimate,
            costMicros: embeddingCostMicros(estimate, next.inputPriceMicros),
          },
        }),
    },
  });
  return c.json(await embeddingsStatus());
});

function generationId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw notFound('No such embedding generation');
  return id;
}

/**
 * "Switch now": searches move to the generation being filled, even before it
 * covers every passage (`force`). Passages it does not cover yet are found by
 * keyword only until the job embeds them. 409 when it is not being filled, or
 * while the upgrade from v0.10 is unfinished (generation 1's table).
 */
embeddingsRoutes.post('/generations/:id/switch', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, embeddingsSwitchSchema);
  try {
    await switchGeneration(generationId(c.req.param('id')), {
      force: input.force === true,
      actor: { id: actor.id, email: actor.email },
    });
  } catch (error) {
    if (error instanceof GenerationStateError || error instanceof SwitchBlockedError) {
      throw conflict(error.message);
    }
    throw error;
  }
  return c.json(await embeddingsStatus());
});

/** "Cancel rebuild": the filling generation is abandoned; searches stay where they are. */
embeddingsRoutes.post('/generations/:id/cancel', async (c) => {
  const actor = currentUser(c);
  try {
    await cancelRebuild(generationId(c.req.param('id')), { id: actor.id, email: actor.email });
  } catch (error) {
    if (error instanceof GenerationStateError) throw conflict(error.message);
    throw error;
  }
  kickJob(EMBEDDINGS_REBUILD_JOB);
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

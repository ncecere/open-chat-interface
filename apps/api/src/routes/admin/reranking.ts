import { eq, schema } from '@oci/db';
import {
  providerCanRerank,
  type RerankingSettings,
  type RerankingTestResult,
  rerankingTestSchema,
  updateRerankingSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { rerankingSettings } from '../../services/reranking/config.js';
import { rerankingStatus, testReranker } from '../../services/reranking/reranker.js';
import { updateSetting } from '../../services/settings.js';

/**
 * Optional reranking of project-file search: a reranking model on an existing
 * provider's Cohere-compatible `<base URL>/rerank` endpoint. It needs no
 * pgvector. Reads are open to auditors; every change and test is audited.
 */
export const rerankingRoutes = new Hono<AppBindings>();

/** Words for an administrator; provider errors can be long. */
function failureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : 'unknown error';
  return `The model could not rerank a sample: ${detail}`.slice(0, 500);
}

/** The reranking setting and the endpoint it will call; the provider key is never returned. */
rerankingRoutes.get('/', async (c) => c.json(await rerankingStatus()));

/**
 * Saves the setting. Switching reranking on, or changing the provider or
 * model while it is on, reranks a sample first: a model that cannot rerank
 * cannot be switched on. While off, anything may be saved untested.
 */
rerankingRoutes.put('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateRerankingSchema);
  const previous = await rerankingSettings({ fresh: true });
  const next: RerankingSettings = {
    ...previous,
    ...(input.enabled !== undefined && { enabled: input.enabled }),
    ...(input.providerId !== undefined && { providerId: input.providerId }),
    ...(input.modelId !== undefined && { modelId: input.modelId }),
    ...(input.searchPriceMicros !== undefined && { searchPriceMicros: input.searchPriceMicros }),
  };

  if (next.providerId && next.providerId !== previous.providerId) {
    const [provider] = await db
      .select({ kind: schema.provider.kind, baseUrl: schema.provider.baseUrl })
      .from(schema.provider)
      .where(eq(schema.provider.id, next.providerId))
      .limit(1);
    if (!provider) throw validationFailed('That provider does not exist.');
    if (!providerCanRerank(provider)) {
      throw validationFailed(
        'That provider cannot rerank. Choose an OpenAI-compatible provider, or an OpenAI provider with a base URL.',
      );
    }
  }
  if (next.enabled && (!next.providerId || !next.modelId)) {
    throw validationFailed('Choose a provider and a model before turning reranking on.');
  }

  const modelChanged = next.providerId !== previous.providerId || next.modelId !== previous.modelId;
  let latencyMs: number | null = null;
  if (next.enabled && (modelChanged || !previous.enabled)) {
    try {
      latencyMs = (await testReranker(next)).latencyMs;
    } catch (error) {
      throw validationFailed(failureMessage(error));
    }
  }

  await updateSetting('reranking', next);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'reranking.update',
    targetType: 'instance',
    metadata: {
      previous: { ...previous },
      next: { ...next },
      ...(latencyMs !== null && { latencyMs }),
    },
  });
  return c.json(await rerankingStatus());
});

/** Reranks a tiny sample with the model on the page (or the saved one). Nothing is stored. */
rerankingRoutes.post('/test', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, rerankingTestSchema);
  const saved = await rerankingSettings();
  const target = {
    providerId: input.providerId ?? saved.providerId,
    modelId: input.modelId ?? saved.modelId,
  };
  let result: RerankingTestResult;
  try {
    const { endpoint, latencyMs } = await testReranker(target);
    result = { ok: true, latencyMs, endpoint };
  } catch (error) {
    result = { ok: false, message: failureMessage(error) };
  }
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'reranking.test',
    targetType: 'instance',
    metadata: {
      ...target,
      ok: result.ok,
      ...(result.ok && { latencyMs: result.latencyMs, endpoint: result.endpoint }),
    },
  });
  return c.json(result);
});

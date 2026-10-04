import type { UserRole } from '@oci/shared';
import { isDraining } from '../../../lib/drain.js';
import { logger } from '../../../lib/logger.js';
import { sharedRedis } from '../../chat-streams.js';
import {
  providerQueueWaitDuration,
  providerQueueWaits,
  providerRetries,
  providerThrottles,
  registerCollectedGauge,
} from '../../observability/metrics.js';
import type { Throttle } from '../../providers/retry.js';
import { MemoryCapacityStore } from './memory-store.js';
import { CapacityQueue, type CapacityRequest } from './queue.js';
import { capacityKeyPrefix, RedisCapacityStore } from './redis-store.js';
import { limitsForModel, queueSettingsFor } from './settings.js';
import type { CapacityStore } from './store.js';

/**
 * Provider capacity for this process (v0.11 design, item 15): the queue,
 * the store it uses (Redis when it works, else this process's own), handing
 * a turn's place over when this replica drains, and the metrics.
 */

const local = new MemoryCapacityStore();
let shared: { client: unknown; store: RedisCapacityStore } | null = null;

async function currentStore(): Promise<CapacityStore> {
  const redis = await sharedRedis();
  if (!redis) return local;
  if (shared?.client !== redis) shared = { client: redis, store: new RedisCapacityStore(redis) };
  return shared.store;
}

/** Metric labels of the turns waiting here, by ticket. */
const labels = new Map<string, { provider: string; model: string }>();

const queue = new CapacityQueue({
  store: currentStore,
  local,
  limits: limitsForModel,
  draining: isDraining,
  log: (message, details) => logger.warn(details, message),
  onWaitEnd: (outcome, waitedMs, ticket) => {
    const label = labels.get(ticket.id) ?? {
      provider: ticket.providerId,
      model: ticket.modelId,
    };
    providerQueueWaits.inc({ ...label, outcome });
    providerQueueWaitDuration.observe(label, waitedMs / 1000);
  },
});

registerCollectedGauge(
  'oci_provider_queue_waiting',
  'Turns waiting for provider capacity on this replica.',
  [],
  async () => [{ value: queue.size }],
);

export interface CapacityModel {
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  slug: string;
}

/**
 * Asks for room for one turn's model request. Models without an id (tests,
 * or a model resolved before v0.11) and models with no limits are admitted
 * at once. Settings that cannot be read admit the turn: availability beats
 * strictness, as for the per-person limits.
 */
export async function requestTurnCapacity(input: {
  runId: string;
  model: CapacityModel;
  user: { id: string; role: UserRole };
  tokens: number;
  /** The prompt a regenerated turn answers, to take back a handed-over place. */
  promptMessageId?: string | null;
}): Promise<CapacityRequest> {
  const { providerId, modelId } = input.model;
  const unlimited: CapacityRequest = {
    kind: 'admitted',
    lease: {
      queued: false,
      waitedMs: 0,
      chargeRequest: () => undefined,
      settle: async () => undefined,
      release: async () => undefined,
    },
  };
  if (!providerId || !modelId) return unlimited;
  try {
    const { maxWaitMs, priorityOffsetMs } = await queueSettingsFor(input.user.role);
    const handoffTag = input.promptMessageId
      ? await takeHandoff(providerId, input.promptMessageId)
      : null;
    labels.set(input.runId, {
      provider: input.model.providerLabel ?? providerId,
      model: input.model.slug,
    });
    const request = await queue.request({
      id: input.runId,
      providerId,
      modelId,
      personId: input.user.id,
      tokens: input.tokens,
      priorityOffsetMs,
      maxWaitMs,
      handoffTag,
    });
    if (request.kind === 'admitted') labels.delete(input.runId);
    else {
      const wait = request.wait;
      request.wait = (options) => wait(options).finally(() => labels.delete(input.runId));
    }
    return request;
  } catch (error) {
    labels.delete(input.runId);
    logger.warn(
      { error, providerId, modelId },
      'Provider capacity unavailable; admitting the turn',
    );
    return unlimited;
  }
}

/**
 * The provider asked OCI to slow down. Counted, and when the model or its
 * provider has limits, admissions to the narrowest limited scope pause for
 * the time the provider asked (two seconds when it did not say): turns still
 * waiting stay queued instead of meeting the same refusal, and the replies
 * already admitted retry first.
 */
export async function reportThrottle(model: CapacityModel, throttle: Throttle): Promise<void> {
  const label = { provider: model.providerLabel ?? model.providerId ?? '', model: model.slug };
  providerThrottles.inc({ ...label, status: String(throttle.status) });
  if (throttle.retrying) providerRetries.inc(label);
  const { providerId, modelId } = model;
  if (!providerId || !modelId) return;
  try {
    const limits = await limitsForModel(providerId, modelId);
    const store = await currentStore();
    await store.recordThrottle(providerId);
    if (!limits || throttle.status !== 429) return;
    const scoped = limits.models[modelId] ? modelId : null;
    await store.coolDown(providerId, scoped, Math.min(throttle.retryAfterMs ?? 2_000, 60_000));
  } catch (error) {
    logger.warn({ error, providerId }, 'Could not record a provider throttle');
  }
}

/** Places handed over by a draining replica, without Redis. */
const localHandoffs = new Map<string, { tag: number; until: number }>();
const HANDOFF_MS = 2 * 60_000;

/** Keeps a handed-over turn's place for when it is sent again (two minutes). */
export async function recordHandoff(
  providerId: string,
  promptMessageId: string,
  tag: number,
): Promise<void> {
  const key = `${capacityKeyPrefix(providerId)}handoff:${promptMessageId}`;
  try {
    const redis = await sharedRedis();
    if (redis) {
      await redis.set(key, String(tag), 'PX', HANDOFF_MS);
      return;
    }
  } catch (error) {
    logger.warn({ error }, 'Could not keep a handed-over turn’s place');
  }
  localHandoffs.set(key, { tag, until: Date.now() + HANDOFF_MS });
}

async function takeHandoff(providerId: string, promptMessageId: string): Promise<number | null> {
  const key = `${capacityKeyPrefix(providerId)}handoff:${promptMessageId}`;
  const held = localHandoffs.get(key);
  localHandoffs.delete(key);
  if (held && held.until > Date.now()) return held.tag;
  const redis = await sharedRedis();
  if (!redis) return null;
  const value = await redis.getdel(key);
  const tag = Number(value);
  return value !== null && Number.isFinite(tag) ? tag : null;
}

/** For System health and the Providers page. */
export async function providerCapacityStatus(providerId: string) {
  const store = await currentStore();
  return { kind: store.kind, status: await store.status(providerId) };
}

/** Test seam. */
export function resetCapacityForTests(): void {
  queue.clear();
  local.clear();
  labels.clear();
  localHandoffs.clear();
  shared = null;
}

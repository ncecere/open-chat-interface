import {
  type CapacityLimits,
  type CapacityQueueSettings,
  capacityLimitsSchema,
  DEFAULT_CAPACITY_QUEUE_SETTINGS,
  hasCapacityLimits,
  MAX_QUEUE_WAIT_SECONDS,
  MIN_QUEUE_WAIT_SECONDS,
  NO_CAPACITY_LIMITS,
  QUEUE_PRIORITIES,
  type QueuePriority,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { getSetting, type StoredProviderCapacitySettings, updateSetting } from '../../settings.js';
import type { ProviderLimits, ScopeLimits } from './store.js';

/** Stored limits as the shared shape; anything malformed reads as no limit. */
export function normalizeLimits(stored: Partial<CapacityLimits> | undefined): CapacityLimits {
  const parsed = capacityLimitsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : NO_CAPACITY_LIMITS;
}

export function normalizeQueueSettings(
  stored: StoredProviderCapacitySettings['queue'],
): CapacityQueueSettings {
  const wait = stored?.maxWaitSeconds;
  const rolePriority = { ...DEFAULT_CAPACITY_QUEUE_SETTINGS.rolePriority };
  for (const role of USER_ROLES) {
    const value = stored?.rolePriority?.[role];
    if (value && (QUEUE_PRIORITIES as readonly string[]).includes(value))
      rolePriority[role] = value;
  }
  return {
    maxWaitSeconds:
      typeof wait === 'number' &&
      Number.isInteger(wait) &&
      wait >= MIN_QUEUE_WAIT_SECONDS &&
      wait <= MAX_QUEUE_WAIT_SECONDS
        ? wait
        : DEFAULT_CAPACITY_QUEUE_SETTINGS.maxWaitSeconds,
    rolePriority,
  };
}

export async function capacitySettings() {
  const stored = await getSetting('providerCapacity');
  return {
    providers: stored.providers ?? {},
    models: stored.models ?? {},
    queue: normalizeQueueSettings(stored.queue),
  };
}

const toScope = (limits: CapacityLimits): ScopeLimits => ({
  rpm: limits.requestsPerMinute,
  tpm: limits.tokensPerMinute,
  streams: limits.maxConcurrentStreams,
});

/**
 * The limits a turn on this model must respect: the provider's, and every
 * limited model's (the queue is per provider, and the turn at its head may be
 * for another of its models; limits of other providers' models are never
 * looked up there). Null when neither the provider nor this model has any:
 * such a turn never queues.
 */
export async function limitsForModel(
  providerId: string,
  modelId: string,
): Promise<ProviderLimits | null> {
  const settings = await capacitySettings();
  const provider = normalizeLimits(settings.providers[providerId]);
  const own = normalizeLimits(settings.models[modelId]);
  if (!hasCapacityLimits(provider) && !hasCapacityLimits(own)) return null;
  const models: Record<string, ScopeLimits> = {};
  for (const [id, stored] of Object.entries(settings.models)) {
    const limits = normalizeLimits(stored);
    if (hasCapacityLimits(limits)) models[id] = toScope(limits);
  }
  return { providerId, provider: toScope(provider), models };
}

/** Queue order: `high` a minute ahead of `normal`, `low` a minute behind. */
export const PRIORITY_OFFSET_MS: Record<QueuePriority, number> = {
  high: -60_000,
  normal: 0,
  low: 60_000,
};

export async function queueSettingsFor(role: UserRole) {
  const { queue } = await capacitySettings();
  return {
    maxWaitMs: queue.maxWaitSeconds * 1000,
    priorityOffsetMs: PRIORITY_OFFSET_MS[queue.rolePriority[role] ?? 'normal'],
  };
}

export async function saveProviderLimits(providerId: string, limits: CapacityLimits) {
  const current = await getSetting('providerCapacity');
  const providers = { ...(current.providers ?? {}) };
  if (hasCapacityLimits(limits)) providers[providerId] = limits;
  else delete providers[providerId];
  await updateSetting('providerCapacity', { providers });
}

export async function saveModelLimits(modelId: string, limits: CapacityLimits) {
  const current = await getSetting('providerCapacity');
  const models = { ...(current.models ?? {}) };
  if (hasCapacityLimits(limits)) models[modelId] = limits;
  else delete models[modelId];
  await updateSetting('providerCapacity', { models });
}

export async function saveQueueSettings(patch: {
  maxWaitSeconds?: number;
  rolePriority?: Partial<Record<UserRole, QueuePriority>>;
}) {
  const current = normalizeQueueSettings((await getSetting('providerCapacity')).queue);
  const queue: CapacityQueueSettings = {
    maxWaitSeconds: patch.maxWaitSeconds ?? current.maxWaitSeconds,
    rolePriority: { ...current.rolePriority, ...patch.rolePriority },
  };
  await updateSetting('providerCapacity', { queue });
  return queue;
}

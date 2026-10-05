import { z } from 'zod';
import { USER_ROLES, type UserRole } from '../constants.js';

/**
 * Provider capacity (v0.11 design, item 15): limits OCI keeps below a model
 * provider's own rate limits, shared by every API replica, and the queue a
 * turn waits in when they are reached.
 */

export const MAX_REQUESTS_PER_MINUTE = 1_000_000;
export const MAX_TOKENS_PER_MINUTE = 1_000_000_000;
export const MAX_CONCURRENT_STREAMS = 100_000;
export const DEFAULT_MAX_QUEUE_WAIT_SECONDS = 120;
export const MIN_QUEUE_WAIT_SECONDS = 5;
export const MAX_QUEUE_WAIT_SECONDS = 1_800;

const limit = (max: number, what: string) =>
  z
    .number()
    .int(`${what} must be a whole number.`)
    .positive(`${what} must be at least 1, or empty for no limit.`)
    .max(max, `${what} can be at most ${max.toLocaleString('en-US')}.`)
    .nullable();

/** One provider's or model's limits. Null (or absent) means no limit. */
export const capacityLimitsSchema = z.object({
  requestsPerMinute: limit(MAX_REQUESTS_PER_MINUTE, 'Requests per minute').default(null),
  tokensPerMinute: limit(MAX_TOKENS_PER_MINUTE, 'Tokens per minute').default(null),
  maxConcurrentStreams: limit(MAX_CONCURRENT_STREAMS, 'Concurrent streams').default(null),
});
export type CapacityLimits = z.infer<typeof capacityLimitsSchema>;

export const NO_CAPACITY_LIMITS: CapacityLimits = {
  requestsPerMinute: null,
  tokensPerMinute: null,
  maxConcurrentStreams: null,
};

export function hasCapacityLimits(limits: CapacityLimits | null | undefined): boolean {
  return Boolean(
    limits &&
      (limits.requestsPerMinute !== null ||
        limits.tokensPerMinute !== null ||
        limits.maxConcurrentStreams !== null),
  );
}

/**
 * Queue order by role. `high` starts a minute ahead of `normal`, `low` a
 * minute behind: a turn never waits behind a higher role forever, only until
 * it has waited a minute longer than the newcomer.
 */
export const QUEUE_PRIORITIES = ['high', 'normal', 'low'] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export const capacityQueueSettingsSchema = z.object({
  maxWaitSeconds: z
    .number()
    .int('Maximum wait must be a whole number of seconds.')
    .min(MIN_QUEUE_WAIT_SECONDS, `Maximum wait must be at least ${MIN_QUEUE_WAIT_SECONDS} seconds.`)
    .max(MAX_QUEUE_WAIT_SECONDS, `Maximum wait can be at most ${MAX_QUEUE_WAIT_SECONDS} seconds.`),
  rolePriority: z.record(z.enum(USER_ROLES), z.enum(QUEUE_PRIORITIES)),
});
export type CapacityQueueSettings = {
  maxWaitSeconds: number;
  rolePriority: Record<UserRole, QueuePriority>;
};

export const updateCapacityQueueSchema = z.object({
  maxWaitSeconds: capacityQueueSettingsSchema.shape.maxWaitSeconds.optional(),
  rolePriority: z.partialRecord(z.enum(USER_ROLES), z.enum(QUEUE_PRIORITIES)).optional(),
});
export type UpdateCapacityQueueInput = z.infer<typeof updateCapacityQueueSchema>;

export const DEFAULT_CAPACITY_QUEUE_SETTINGS: CapacityQueueSettings = {
  maxWaitSeconds: DEFAULT_MAX_QUEUE_WAIT_SECONDS,
  rolePriority: { admin: 'normal', auditor: 'normal', user: 'normal', restricted: 'normal' },
};

/** Live state of one provider's queue and limits, for administrators. */
export interface ProviderCapacityStatus {
  providerId: string;
  label: string;
  limits: CapacityLimits;
  /** Turns waiting now, across replicas (this replica only without Redis). */
  queued: number;
  /** Replies holding a stream slot now. */
  activeStreams: number;
  /** Rate-limit (429) and overload responses from the provider in the last hour. */
  throttledLastHour: number;
  /** Turns that waited in the last hour, and how long. */
  waitsLastHour: number;
  longestWaitSeconds: number | null;
  /** The provider asked OCI to pause until then (ISO time), or null. */
  coolingUntil: string | null;
  models: Array<{ modelId: string; slug: string; displayName: string; limits: CapacityLimits }>;
}

export interface ProviderCapacityOverview {
  queue: CapacityQueueSettings;
  /** `shared` when every replica enforces the limits together through Redis. */
  enforcement: 'shared' | 'local';
  providers: ProviderCapacityStatus[];
}

/**
 * The reply part written while a turn waits for capacity (`data-capacity`,
 * id `capacity`), updated in place.
 *
 * - `waiting`: `position` is 1 for the next turn to start.
 * - `admitted`: the wait is over and the reply starts.
 * - `timeout`: the wait passed the maximum; the reply failed.
 * - `handoff`: the server restarted before the reply started; the browser
 *   sends the message again (to a server that is running) by itself.
 */
export const CAPACITY_PART_TYPE = 'data-capacity';
export const CAPACITY_PART_ID = 'capacity';
export type CapacityWaitState = 'waiting' | 'admitted' | 'timeout' | 'handoff';
export interface CapacityWaitData {
  state: CapacityWaitState;
  /** The model's display name. */
  model: string;
  position: number | null;
  estimatedWaitSeconds: number | null;
  waitedSeconds: number;
}

/** The capacity part's data, when a message part is one. */
export function capacityWaitOfPart(part: unknown): CapacityWaitData | null {
  if (typeof part !== 'object' || part === null) return null;
  const candidate = part as { type?: unknown; data?: unknown };
  if (candidate.type !== CAPACITY_PART_TYPE) return null;
  const data = candidate.data as Partial<CapacityWaitData> | null;
  if (
    !data ||
    typeof data !== 'object' ||
    !['waiting', 'admitted', 'timeout', 'handoff'].includes(data.state as string)
  )
    return null;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    state: data.state as CapacityWaitState,
    model: typeof data.model === 'string' ? data.model : '',
    position: count(data.position),
    estimatedWaitSeconds: count(data.estimatedWaitSeconds),
    waitedSeconds: count(data.waitedSeconds) ?? 0,
  };
}

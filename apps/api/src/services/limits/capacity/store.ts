/**
 * Provider capacity (v0.11 design, item 15): the state every replica shares.
 *
 * Per provider there is one queue, ordered by a tag (start-time fair
 * queuing: a person's waiting turns are spaced `spacingMs` apart, so one
 * person with many tabs takes every other place at most, and role priority
 * shifts the tag), and per scope (the provider, and each limited model):
 *
 * - a token bucket of requests (capacity: requests per minute, refilled
 *   continuously), as providers meter them;
 * - a token bucket of tokens (capacity: tokens per minute), debited by an
 *   estimate at admission and settled with the reported usage, so it may go
 *   below zero after a reply that used more than estimated;
 * - leases on concurrent streams, each with an expiry renewed while its reply
 *   runs, so a crashed replica's slots free themselves;
 * - a cool-down set when the provider answers 429 with Retry-After.
 *
 * Admission walks the queue from its head: a turn is admitted when the
 * provider and its model both have room. A turn blocked only by its own
 * model's limit is passed over (it could not use the provider's room anyway);
 * one blocked by the provider stops the walk, so no later turn overtakes it.
 * Any replica's walk admits any replica's turns; the owner picks its
 * admission up on its next poll. A turn's ticket lives only while its owner
 * polls it, so a dead replica's turns leave the queue within `aliveMs`.
 */

export interface ScopeLimits {
  rpm: number | null;
  tpm: number | null;
  streams: number | null;
}

export interface ProviderLimits {
  providerId: string;
  provider: ScopeLimits;
  /** Limited models (of any provider; only those in this queue are read). */
  models: Record<string, ScopeLimits>;
}

export interface Ticket {
  id: string;
  providerId: string;
  modelId: string;
  personId: string;
  /** Estimated tokens this turn uses (input plus reserved output). */
  tokens: number;
  priorityOffsetMs: number;
  /** A tag carried over from a turn handed back by a draining replica. */
  handoffTag?: number | null;
}

export type TicketStatus =
  | { state: 'admitted' }
  | { state: 'waiting'; position: number; etaSeconds: number | null }
  | { state: 'gone' };

export interface ScopeStatus {
  queued: number;
  activeStreams: number;
  throttledLastHour: number;
  waitsLastHour: number;
  longestWaitMs: number | null;
  coolingUntil: number | null;
}

export interface StoreTimings {
  /** A waiting ticket disappears this long after its owner last polled it. */
  aliveMs: number;
  /** A reply's stream lease lasts this long unless renewed. */
  leaseMs: number;
  /** An admission not yet picked up by its owner holds its slot this long. */
  pickupMs: number;
  /** Queue spacing of one person's turns. */
  spacingMs: number;
  /** Queue entries examined per admission walk. */
  scan: number;
}

export const DEFAULT_TIMINGS: StoreTimings = {
  aliveMs: 10_000,
  leaseMs: 30_000,
  pickupMs: 10_000,
  spacingMs: 10_000,
  scan: 64,
};

export interface CapacityStore {
  readonly kind: 'shared' | 'local';
  /** Queues a turn and walks the queue; the turn may be admitted at once. */
  enqueue(limits: ProviderLimits, ticket: Ticket): Promise<{ tag: number; status: TicketStatus }>;
  /**
   * Keeps this replica's tickets alive, walks the queue, and reports each
   * ticket. An admitted ticket is picked up: its leases get the full term.
   */
  poll(limits: ProviderLimits, ticketIds: string[]): Promise<Map<string, TicketStatus>>;
  /** Leaves the queue (and frees a slot granted but not picked up). */
  cancel(providerId: string, modelId: string, ticketId: string): Promise<void>;
  renew(providerId: string, modelId: string, leaseId: string): Promise<void>;
  release(providerId: string, modelId: string, leaseId: string): Promise<void>;
  /** Debits (or, negative, refunds) requests and tokens without waiting. */
  charge(limits: ProviderLimits, modelId: string, requests: number, tokens: number): Promise<void>;
  /** Pauses admissions to a scope (`modelId` null: the provider) for `ms`. */
  coolDown(providerId: string, modelId: string | null, ms: number): Promise<void>;
  recordThrottle(providerId: string): Promise<void>;
  recordWait(providerId: string, waitedMs: number): Promise<void>;
  status(providerId: string): Promise<ScopeStatus>;
}

/** Limits as passed to the store's scripts: -1 for none. */
export function encodeLimits(limits: ProviderLimits): string {
  const scope = (s: ScopeLimits) => [s.rpm ?? -1, s.tpm ?? -1, s.streams ?? -1];
  return JSON.stringify({
    p: scope(limits.provider),
    m: Object.fromEntries(Object.entries(limits.models).map(([id, s]) => [id, scope(s)])),
  });
}

export const HOUR_MS = 60 * 60 * 1000;

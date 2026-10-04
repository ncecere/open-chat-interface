import {
  type CapacityStore,
  DEFAULT_TIMINGS,
  HOUR_MS,
  type ProviderLimits,
  type ScopeLimits,
  type ScopeStatus,
  type StoreTimings,
  type Ticket,
  type TicketStatus,
} from './store.js';

/**
 * The same algorithm as the Redis store, in this process only: the fallback
 * when Redis is not configured or not reachable. Each replica then enforces
 * the whole limit on its own, so N replicas may together reach N times the
 * limit; the queue and its order hold per replica.
 */

const NONE: ScopeLimits = { rpm: null, tpm: null, streams: null };

interface Bucket {
  level: number;
  at: number;
}

interface Scope {
  requests?: Bucket;
  tokens?: Bucket;
  leases: Map<string, number>;
  coolUntil: number;
}

interface Entry {
  id: string;
  tag: number;
  modelId: string;
  tokens: number;
  admitted: boolean;
  aliveUntil: number;
}

interface ProviderState {
  queue: Entry[];
  scopes: Map<string, Scope>;
  last: Map<string, { tag: number; until: number }>;
  admissions: number[];
  throttles: number[];
  waits: Array<{ at: number; ms: number }>;
}

function level(bucket: Bucket | undefined, cap: number, now: number): number {
  if (!bucket) return cap;
  return Math.min(cap, bucket.level + ((now - bucket.at) * cap) / 60_000);
}

export class MemoryCapacityStore implements CapacityStore {
  readonly kind = 'local' as const;
  private readonly providers = new Map<string, ProviderState>();
  private readonly timings: StoreTimings;

  constructor(
    timings: Partial<StoreTimings> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  /** Test seam. */
  clear(): void {
    this.providers.clear();
  }

  private state(providerId: string): ProviderState {
    let state = this.providers.get(providerId);
    if (!state) {
      state = {
        queue: [],
        scopes: new Map(),
        last: new Map(),
        admissions: [],
        throttles: [],
        waits: [],
      };
      this.providers.set(providerId, state);
    }
    return state;
  }

  private scope(state: ProviderState, key: string): Scope {
    let scope = state.scopes.get(key);
    if (!scope) {
      scope = { leases: new Map(), coolUntil: 0 };
      state.scopes.set(key, scope);
    }
    return scope;
  }

  private activeLeases(scope: Scope, now: number): number {
    for (const [id, until] of scope.leases) if (until <= now) scope.leases.delete(id);
    return scope.leases.size;
  }

  private hasRoom(scope: Scope, limits: ScopeLimits, tokens: number, now: number): boolean {
    if (scope.coolUntil > now) return false;
    if (limits.rpm !== null && level(scope.requests, limits.rpm, now) < 1) return false;
    if (limits.tpm !== null && level(scope.tokens, limits.tpm, now) < Math.min(tokens, limits.tpm))
      return false;
    if (limits.streams !== null && this.activeLeases(scope, now) >= limits.streams) return false;
    return true;
  }

  private debit(
    scope: Scope,
    limits: ScopeLimits,
    requests: number,
    tokens: number,
    now: number,
  ): void {
    if (limits.rpm !== null)
      scope.requests = {
        level: Math.max(-limits.rpm, level(scope.requests, limits.rpm, now) - requests),
        at: now,
      };
    if (limits.tpm !== null)
      scope.tokens = {
        level: Math.max(-limits.tpm, level(scope.tokens, limits.tpm, now) - tokens),
        at: now,
      };
  }

  private pump(state: ProviderState, limits: ProviderLimits, now: number): void {
    const provider = this.scope(state, 'p');
    state.queue = state.queue.filter((entry) => entry.admitted || entry.aliveUntil > now);
    let examined = 0;
    for (const entry of [...state.queue]) {
      if (entry.admitted) continue;
      if (++examined > this.timings.scan) break;
      if (!this.hasRoom(provider, limits.provider, entry.tokens, now)) break;
      const modelLimits = limits.models[entry.modelId] ?? NONE;
      const model = this.scope(state, `m:${entry.modelId}`);
      if (!this.hasRoom(model, modelLimits, entry.tokens, now)) continue;
      for (const [scope, scopeLimits] of [
        [provider, limits.provider],
        [model, modelLimits],
      ] as const) {
        this.debit(scope, scopeLimits, 1, entry.tokens, now);
        scope.leases.set(entry.id, now + this.timings.pickupMs);
      }
      entry.admitted = true;
      state.admissions.push(now);
    }
  }

  private statusOf(state: ProviderState, id: string, now: number): TicketStatus {
    const index = state.queue.findIndex((entry) => entry.id === id);
    const entry = state.queue[index];
    if (!entry) return { state: 'gone' };
    if (entry.admitted) {
      // Picked up: the leases get their full term, and the ticket is done.
      for (const key of ['p', `m:${entry.modelId}`]) {
        const scope = this.scope(state, key);
        if (scope.leases.has(id)) scope.leases.set(id, now + this.timings.leaseMs);
      }
      state.queue.splice(index, 1);
      return { state: 'admitted' };
    }
    const position = state.queue.slice(0, index).filter((other) => !other.admitted).length;
    state.admissions = state.admissions.filter((at) => at > now - 60_000);
    const rate = state.admissions.length;
    return {
      state: 'waiting',
      position: position + 1,
      etaSeconds: rate > 0 ? Math.ceil(((position + 1) * 60) / rate) : null,
    };
  }

  async enqueue(limits: ProviderLimits, ticket: Ticket) {
    const now = this.now();
    const state = this.state(ticket.providerId);
    const last = state.last.get(ticket.personId);
    let base = now;
    if (ticket.handoffTag != null) base = ticket.handoffTag;
    else if (last && last.until > now && last.tag + this.timings.spacingMs > now)
      base = last.tag + this.timings.spacingMs;
    if (ticket.handoffTag == null) {
      if (state.last.size > 10_000)
        for (const [person, value] of state.last) if (value.until <= now) state.last.delete(person);
      state.last.set(ticket.personId, { tag: base, until: now + 600_000 });
    }
    const tag = base + ticket.priorityOffsetMs;
    const entry: Entry = {
      id: ticket.id,
      tag,
      modelId: ticket.modelId,
      tokens: ticket.tokens,
      admitted: false,
      aliveUntil: now + this.timings.aliveMs,
    };
    // Equal tags keep arrival order.
    const at = state.queue.findIndex((other) => other.tag > tag);
    state.queue.splice(at === -1 ? state.queue.length : at, 0, entry);
    this.pump(state, limits, now);
    return { tag: base, status: this.statusOf(state, ticket.id, now) };
  }

  async poll(limits: ProviderLimits, ticketIds: string[]) {
    const now = this.now();
    const state = this.state(limits.providerId);
    const mine = new Set(ticketIds);
    for (const entry of state.queue)
      if (mine.has(entry.id)) entry.aliveUntil = now + this.timings.aliveMs;
    this.pump(state, limits, now);
    return new Map(ticketIds.map((id) => [id, this.statusOf(state, id, now)]));
  }

  async cancel(providerId: string, modelId: string, ticketId: string) {
    const state = this.state(providerId);
    state.queue = state.queue.filter((entry) => entry.id !== ticketId);
    await this.release(providerId, modelId, ticketId);
  }

  async renew(providerId: string, modelId: string, leaseId: string) {
    const now = this.now();
    const state = this.state(providerId);
    for (const key of ['p', `m:${modelId}`]) {
      const scope = this.scope(state, key);
      if (scope.leases.has(leaseId)) scope.leases.set(leaseId, now + this.timings.leaseMs);
    }
  }

  async release(providerId: string, modelId: string, leaseId: string) {
    const state = this.state(providerId);
    for (const key of ['p', `m:${modelId}`]) this.scope(state, key).leases.delete(leaseId);
  }

  async charge(limits: ProviderLimits, modelId: string, requests: number, tokens: number) {
    const now = this.now();
    const state = this.state(limits.providerId);
    this.debit(this.scope(state, 'p'), limits.provider, requests, tokens, now);
    this.debit(
      this.scope(state, `m:${modelId}`),
      limits.models[modelId] ?? NONE,
      requests,
      tokens,
      now,
    );
  }

  async coolDown(providerId: string, modelId: string | null, ms: number) {
    const scope = this.scope(this.state(providerId), modelId ? `m:${modelId}` : 'p');
    scope.coolUntil = Math.max(scope.coolUntil, this.now() + ms);
  }

  async recordThrottle(providerId: string) {
    const now = this.now();
    const state = this.state(providerId);
    state.throttles = [...state.throttles.filter((at) => at > now - HOUR_MS), now];
  }

  async recordWait(providerId: string, waitedMs: number) {
    const now = this.now();
    const state = this.state(providerId);
    state.waits = [
      ...state.waits.filter((wait) => wait.at > now - HOUR_MS),
      { at: now, ms: waitedMs },
    ];
  }

  async status(providerId: string): Promise<ScopeStatus> {
    const now = this.now();
    const state = this.state(providerId);
    const provider = this.scope(state, 'p');
    const waits = state.waits.filter((wait) => wait.at > now - HOUR_MS);
    return {
      queued: state.queue.filter((entry) => !entry.admitted && entry.aliveUntil > now).length,
      activeStreams: this.activeLeases(provider, now),
      throttledLastHour: state.throttles.filter((at) => at > now - HOUR_MS).length,
      waitsLastHour: waits.length,
      longestWaitMs: waits.length ? Math.max(...waits.map((wait) => wait.ms)) : null,
      coolingUntil: provider.coolUntil > now ? provider.coolUntil : null,
    };
  }
}

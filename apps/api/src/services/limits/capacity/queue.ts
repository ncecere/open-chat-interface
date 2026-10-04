import type { CapacityStore, ProviderLimits, Ticket, TicketStatus } from './store.js';

/**
 * One replica's side of the provider queue: its waiting turns, polled
 * together (one script per provider per tick, however many wait here), and
 * the lease each admitted turn holds while its reply runs.
 */

export interface CapacityLease {
  /** True when the turn waited in the queue. */
  readonly queued: boolean;
  readonly waitedMs: number;
  /** A later provider request of the same reply (a tool step, a retry): counted, never queued. */
  chargeRequest(): void;
  /** Replaces the admission estimate with the reported usage (null: keep the estimate). */
  settle(actualTokens: number | null): Promise<void>;
  /** Frees the stream slot; safe to call twice. */
  release(): Promise<void>;
}

export type WaitOutcome =
  | { kind: 'admitted'; lease: CapacityLease }
  | { kind: 'cancelled'; waitedMs: number }
  | { kind: 'timeout'; waitedMs: number }
  /** The replica is draining; `tag` keeps the turn's place when it is sent again. */
  | { kind: 'handoff'; waitedMs: number; tag: number };

export interface WaitUpdate {
  position: number;
  etaSeconds: number | null;
  waitedMs: number;
}

export interface WaitOptions {
  signal: AbortSignal;
  onUpdate: (update: WaitUpdate) => void;
  /** Stop requested from another replica; checked about once a second. */
  cancelRequested?: () => Promise<boolean>;
}

export type CapacityRequest =
  | { kind: 'admitted'; lease: CapacityLease }
  | {
      kind: 'waiting';
      first: WaitUpdate;
      wait: (options: WaitOptions) => Promise<WaitOutcome>;
      /** Leaves the queue without waiting (the turn failed before its wait began). */
      cancel: () => Promise<void>;
    };

export interface QueueDependencies {
  /** The store to use now: Redis when it works, else this process's. */
  store: () => Promise<CapacityStore>;
  /** The fallback store, used when the shared one fails mid-wait. */
  local: CapacityStore;
  /** Current limits; null once an administrator removed them all. */
  limits: (providerId: string, modelId: string) => Promise<ProviderLimits | null>;
  draining: () => boolean;
  now?: () => number;
  tickMs?: number;
  renewMs?: number;
  log?: (message: string, details: Record<string, unknown>) => void;
  onWaitEnd?: (outcome: WaitOutcome['kind'], waitedMs: number, ticket: Ticket) => void;
}

interface Waiter {
  ticket: Ticket;
  store: CapacityStore;
  tag: number;
  startedAt: number;
  deadline: number;
  options: WaitOptions;
  lastUpdate: string;
  lastCancelCheck: number;
  resolve: (outcome: WaitOutcome) => void;
}

const UNLIMITED: CapacityLease = {
  queued: false,
  waitedMs: 0,
  chargeRequest: () => undefined,
  settle: async () => undefined,
  release: async () => undefined,
};

export class CapacityQueue {
  private readonly waiters = new Map<string, Waiter>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly renewMs: number;

  constructor(private readonly deps: QueueDependencies) {
    this.now = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? 250;
    this.renewMs = deps.renewMs ?? 10_000;
  }

  /** Turns waiting on this replica. */
  get size(): number {
    return this.waiters.size;
  }

  /**
   * Asks for room for one turn. Unlimited models are admitted without
   * touching any store. A store that fails is passed over for this process's
   * own: availability beats strictness, as for the per-person limits.
   */
  async request(input: {
    id: string;
    providerId: string;
    modelId: string;
    personId: string;
    tokens: number;
    priorityOffsetMs: number;
    maxWaitMs: number;
    handoffTag?: number | null;
  }): Promise<CapacityRequest> {
    const limits = await this.deps.limits(input.providerId, input.modelId);
    if (!limits) return { kind: 'admitted', lease: UNLIMITED };
    const ticket: Ticket = {
      id: input.id,
      providerId: input.providerId,
      modelId: input.modelId,
      personId: input.personId,
      tokens: input.tokens,
      priorityOffsetMs: input.priorityOffsetMs,
      handoffTag: input.handoffTag ?? null,
    };
    const startedAt = this.now();
    let store = await this.deps.store();
    let entered: { tag: number; status: TicketStatus };
    try {
      entered = await store.enqueue(limits, ticket);
    } catch (error) {
      this.deps.log?.('Provider capacity store failed; using this replica’s', { error });
      store = this.deps.local;
      entered = await store.enqueue(limits, ticket);
    }
    if (entered.status.state === 'admitted')
      return { kind: 'admitted', lease: this.lease(store, limits, ticket, startedAt, false) };
    const first =
      entered.status.state === 'waiting'
        ? entered.status
        : { position: 1, etaSeconds: null as number | null };
    return {
      kind: 'waiting',
      first: { position: first.position, etaSeconds: first.etaSeconds, waitedMs: 0 },
      cancel: () =>
        store.cancel(ticket.providerId, ticket.modelId, ticket.id).catch(() => undefined),
      wait: (options) =>
        new Promise<WaitOutcome>((resolve) => {
          const waiter: Waiter = {
            ticket,
            store,
            tag: entered.tag,
            startedAt,
            deadline: startedAt + input.maxWaitMs,
            options,
            lastUpdate: '',
            lastCancelCheck: 0,
            resolve: (outcome) => {
              this.waiters.delete(ticket.id);
              this.deps.onWaitEnd?.(outcome.kind, this.now() - startedAt, ticket);
              resolve(outcome);
            },
          };
          this.waiters.set(ticket.id, waiter);
          if (options.signal.aborted) {
            void this.leave(waiter, { kind: 'cancelled', waitedMs: 0 });
            return;
          }
          options.signal.addEventListener('abort', () => this.nudge(), { once: true });
          this.nudge();
        }),
    };
  }

  /** Runs a tick soon: a slot was freed here, or a waiter changed. */
  nudge(): void {
    if (this.waiters.size === 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.waiters.size === 0) return;
    // Jittered, so replicas do not poll in lockstep.
    const delay = this.tickMs * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private async leave(waiter: Waiter, outcome: WaitOutcome): Promise<void> {
    if (!this.waiters.has(waiter.ticket.id)) return;
    this.waiters.delete(waiter.ticket.id);
    await waiter.store
      .cancel(waiter.ticket.providerId, waiter.ticket.modelId, waiter.ticket.id)
      .catch((error: unknown) => this.deps.log?.('Could not leave the provider queue', { error }));
    waiter.resolve(outcome);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.timer = null;
    try {
      const now = this.now();
      const groups = new Map<string, Waiter[]>();
      for (const waiter of [...this.waiters.values()]) {
        const waitedMs = now - waiter.startedAt;
        if (waiter.options.signal.aborted) {
          await this.leave(waiter, { kind: 'cancelled', waitedMs });
          continue;
        }
        if (this.deps.draining()) {
          await this.leave(waiter, { kind: 'handoff', waitedMs, tag: waiter.tag });
          continue;
        }
        if (now >= waiter.deadline) {
          await this.leave(waiter, { kind: 'timeout', waitedMs });
          continue;
        }
        if (waiter.options.cancelRequested && now - waiter.lastCancelCheck >= 1000) {
          waiter.lastCancelCheck = now;
          if (await waiter.options.cancelRequested().catch(() => false)) {
            await this.leave(waiter, { kind: 'cancelled', waitedMs });
            continue;
          }
        }
        const key = `${waiter.store.kind}\u0000${waiter.ticket.providerId}\u0000${waiter.ticket.modelId}`;
        groups.set(key, [...(groups.get(key) ?? []), waiter]);
      }
      for (const group of groups.values()) await this.pollGroup(group);
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  private async pollGroup(group: Waiter[]): Promise<void> {
    const { providerId, modelId } = group[0]!.ticket;
    const limits = await this.deps.limits(providerId, modelId).catch(() => undefined);
    if (limits === undefined) return;
    if (limits === null) {
      // Every limit was removed while these waited: they go now.
      for (const waiter of group) {
        await waiter.store.cancel(providerId, modelId, waiter.ticket.id).catch(() => undefined);
        waiter.resolve({ kind: 'admitted', lease: UNLIMITED });
      }
      return;
    }
    const store = group[0]!.store;
    let statuses: Map<string, TicketStatus>;
    try {
      statuses = await store.poll(
        limits,
        group.map((waiter) => waiter.ticket.id),
      );
    } catch (error) {
      if (store === this.deps.local) throw error;
      // The shared store failed mid-wait: wait here instead, keeping order.
      this.deps.log?.('Provider capacity store failed while waiting; using this replica’s', {
        error,
      });
      for (const waiter of group) {
        waiter.store = this.deps.local;
        await this.requeue(waiter, limits);
      }
      return;
    }
    const now = this.now();
    for (const waiter of group) {
      const status = statuses.get(waiter.ticket.id) ?? { state: 'gone' as const };
      if (status.state === 'admitted') {
        waiter.resolve({
          kind: 'admitted',
          lease: this.lease(waiter.store, limits, waiter.ticket, waiter.startedAt, true),
        });
      } else if (status.state === 'gone') {
        // The ticket lapsed (this process stalled past its life): queue again in place.
        await this.requeue(waiter, limits).catch(() => undefined);
      } else {
        const update = `${status.position}:${status.etaSeconds}`;
        if (update !== waiter.lastUpdate) {
          waiter.lastUpdate = update;
          waiter.options.onUpdate({
            position: status.position,
            etaSeconds: status.etaSeconds,
            waitedMs: now - waiter.startedAt,
          });
        }
      }
    }
  }

  /** Queues a waiter again with its tag; it may be admitted at once. */
  private async requeue(waiter: Waiter, limits: ProviderLimits): Promise<void> {
    const { status } = await waiter.store.enqueue(limits, {
      ...waiter.ticket,
      handoffTag: waiter.tag,
    });
    if (status.state === 'admitted')
      waiter.resolve({
        kind: 'admitted',
        lease: this.lease(waiter.store, limits, waiter.ticket, waiter.startedAt, true),
      });
  }

  private lease(
    store: CapacityStore,
    limits: ProviderLimits,
    ticket: Ticket,
    startedAt: number,
    queued: boolean,
  ): CapacityLease {
    const { providerId, modelId, id } = ticket;
    let released = false;
    let charged = ticket.tokens;
    const renew = setInterval(() => {
      void store.renew(providerId, modelId, id).catch(() => undefined);
    }, this.renewMs);
    renew.unref?.();
    const waitedMs = this.now() - startedAt;
    if (queued) void store.recordWait(providerId, waitedMs).catch(() => undefined);
    return {
      queued,
      waitedMs,
      chargeRequest: () => {
        void store.charge(limits, modelId, 1, 0).catch(() => undefined);
      },
      settle: async (actual) => {
        if (actual === null || !Number.isFinite(actual)) return;
        const delta = actual - charged;
        charged = actual;
        if (delta !== 0) await store.charge(limits, modelId, 0, delta).catch(() => undefined);
      },
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(renew);
        await store.release(providerId, modelId, id).catch(() => undefined);
        this.nudge();
      },
    };
  }

  /** Test seam: ends every wait as cancelled. */
  clear(): void {
    for (const waiter of [...this.waiters.values()])
      waiter.resolve({ kind: 'cancelled', waitedMs: 0 });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

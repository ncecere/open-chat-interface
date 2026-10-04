import { describe, expect, it, vi } from 'vitest';
import { estimatedTurnTokens } from '../../services/chat/capacity-wait.js';
import { MemoryCapacityStore } from '../../services/limits/capacity/memory-store.js';
import { CapacityQueue, type WaitOutcome } from '../../services/limits/capacity/queue.js';
import {
  normalizeLimits,
  normalizeQueueSettings,
  PRIORITY_OFFSET_MS,
} from '../../services/limits/capacity/settings.js';
import {
  type CapacityStore,
  encodeLimits,
  type ProviderLimits,
  type Ticket,
} from '../../services/limits/capacity/store.js';

/** Provider capacity (v0.11 design, item 15): the algorithm, on this process's store. */

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const limits = (
  provider: Partial<ProviderLimits['provider']>,
  models: ProviderLimits['models'] = {},
): ProviderLimits => ({
  providerId: 'p',
  provider: { rpm: null, tpm: null, streams: null, ...provider },
  models,
});

let next = 0;
const ticket = (personId: string, extra: Partial<Ticket> = {}): Ticket => ({
  id: `t${++next}`,
  providerId: 'p',
  modelId: 'm',
  personId,
  tokens: 10,
  priorityOffsetMs: 0,
  ...extra,
});

describe('memory capacity store', () => {
  it('admits up to the stream limit and queues the rest in order', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ streams: 2 });
    const results = [];
    for (const person of ['a', 'b', 'c', 'd']) results.push(await store.enqueue(l, ticket(person)));
    expect(results.map((r) => r.status)).toEqual([
      { state: 'admitted' },
      { state: 'admitted' },
      { state: 'waiting', position: 1, etaSeconds: 30 },
      { state: 'waiting', position: 2, etaSeconds: 60 },
    ]);
    expect((await store.status('p')).activeStreams).toBe(2);
    expect((await store.status('p')).queued).toBe(2);
  });

  it('spaces one person’s turns so another person’s single turn goes second', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ streams: 1 });
    const many = [];
    for (let i = 0; i < 5; i++) many.push(await store.enqueue(l, ticket('heavy')));
    time.advance(100);
    const light = ticket('light');
    await store.enqueue(l, light);
    const status = await store.poll(l, [light.id]);
    // Next, ahead of the four the heavy person still has waiting.
    expect(status.get(light.id)).toMatchObject({ state: 'waiting', position: 1 });
    const heavyLast = many.at(-1)!;
    expect(heavyLast.status).toMatchObject({ state: 'waiting', position: 4 });
  });

  it('puts a high-priority role ahead and a low one behind, by a minute', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({ aliveMs: 120_000 }, time.now);
    const l = limits({ streams: 1 });
    await store.enqueue(l, ticket('running'));
    const normal = ticket('n');
    const low = ticket('l', { priorityOffsetMs: PRIORITY_OFFSET_MS.low });
    await store.enqueue(l, normal);
    await store.enqueue(l, low);
    time.advance(20_000);
    const high = ticket('h', { priorityOffsetMs: PRIORITY_OFFSET_MS.high });
    await store.enqueue(l, high);
    const statuses = await store.poll(l, [high.id, normal.id, low.id]);
    expect(statuses.get(high.id)).toMatchObject({ position: 1 });
    expect(statuses.get(normal.id)).toMatchObject({ position: 2 });
    expect(statuses.get(low.id)).toMatchObject({ position: 3 });
  });

  it('meters requests per minute as a bucket that refills continuously', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ rpm: 2 });
    expect((await store.enqueue(l, ticket('a'))).status.state).toBe('admitted');
    expect((await store.enqueue(l, ticket('b'))).status.state).toBe('admitted');
    const third = ticket('c');
    expect((await store.enqueue(l, third)).status.state).toBe('waiting');
    time.advance(29_000);
    expect((await store.poll(l, [third.id])).get(third.id)?.state).toBe('waiting');
    time.advance(1_000);
    expect((await store.poll(l, [third.id])).get(third.id)?.state).toBe('admitted');
  });

  it('meters tokens per minute with an estimate settled by the actual use', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ tpm: 1_000 });
    const first = ticket('a', { tokens: 800 });
    expect((await store.enqueue(l, first)).status.state).toBe('admitted');
    const second = ticket('b', { tokens: 400 });
    expect((await store.enqueue(l, second)).status.state).toBe('waiting');
    // The first used less than estimated: the difference comes back.
    await store.charge(l, 'm', 0, -500);
    expect((await store.poll(l, [second.id])).get(second.id)?.state).toBe('admitted');
    // A request larger than a whole minute needs only a full bucket.
    const huge = ticket('c', { tokens: 50_000 });
    time.advance(60_000);
    expect((await store.enqueue(l, huge)).status.state).toBe('admitted');
  });

  it('passes over a turn blocked by its own model, never one blocked by the provider', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ streams: 2 }, { busy: { rpm: null, tpm: null, streams: 1 } });
    await store.enqueue(l, ticket('a', { modelId: 'busy' }));
    const blocked = ticket('b', { modelId: 'busy' });
    expect((await store.enqueue(l, blocked)).status.state).toBe('waiting');
    // Another model of the provider goes past it: the provider has room.
    expect((await store.enqueue(l, ticket('c', { modelId: 'free' }))).status.state).toBe(
      'admitted',
    );
    expect((await store.enqueue(l, ticket('d', { modelId: 'free' }))).status.state).toBe('waiting');
  });

  it('pauses admissions during a cool-down and counts throttles and waits', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({}, time.now);
    const l = limits({ streams: 5 });
    await store.coolDown('p', null, 2_000);
    const waiting = ticket('a');
    expect((await store.enqueue(l, waiting)).status.state).toBe('waiting');
    expect((await store.status('p')).coolingUntil).toBe(time.now() + 2_000);
    time.advance(2_000);
    expect((await store.poll(l, [waiting.id])).get(waiting.id)?.state).toBe('admitted');
    await store.recordThrottle('p');
    await store.recordWait('p', 1_500);
    await store.recordWait('p', 500);
    expect(await store.status('p')).toMatchObject({
      throttledLastHour: 1,
      waitsLastHour: 2,
      longestWaitMs: 1_500,
    });
    time.advance(60 * 60 * 1000 + 1);
    expect(await store.status('p')).toMatchObject({ throttledLastHour: 0, waitsLastHour: 0 });
  });

  it('expires leases that are not renewed and tickets that are not polled', async () => {
    const time = clock();
    const store = new MemoryCapacityStore({ leaseMs: 1_000, aliveMs: 500 }, time.now);
    const l = limits({ streams: 1 });
    const held = ticket('a');
    await store.enqueue(l, held);
    const lost = ticket('b');
    await store.enqueue(l, lost);
    time.advance(600);
    // The waiting ticket lapsed; a newcomer is first now.
    const fresh = ticket('c');
    expect((await store.enqueue(l, fresh)).status).toMatchObject({ position: 1 });
    expect((await store.poll(l, [lost.id])).get(lost.id)).toEqual({ state: 'gone' });
    await store.renew('p', 'm', held.id);
    time.advance(900);
    expect((await store.poll(l, [fresh.id])).get(fresh.id)?.state).toBe('waiting');
    time.advance(200);
    expect((await store.poll(l, [fresh.id])).get(fresh.id)?.state).toBe('admitted');
  });
});

describe('capacity queue', () => {
  function queue(
    store: CapacityStore,
    overrides: Partial<ConstructorParameters<typeof CapacityQueue>[0]> = {},
  ) {
    return new CapacityQueue({
      store: async () => store,
      local: new MemoryCapacityStore(),
      limits: async () => limits({ streams: 1 }),
      draining: () => false,
      tickMs: 5,
      ...overrides,
    });
  }
  const request = (q: CapacityQueue, maxWaitMs = 10_000) =>
    q.request({
      id: `r${++next}`,
      providerId: 'p',
      modelId: 'm',
      personId: 'x',
      tokens: 1,
      priorityOffsetMs: 0,
      maxWaitMs,
    });

  it('admits without any store when nothing is limited', async () => {
    const store = new MemoryCapacityStore();
    const enqueue = vi.spyOn(store, 'enqueue');
    const q = queue(store, { limits: async () => null });
    const result = await request(q);
    expect(result.kind).toBe('admitted');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports position, then admits when a slot is released', async () => {
    const q = queue(new MemoryCapacityStore());
    const held = await request(q);
    const waiting = await request(q);
    if (held.kind !== 'admitted' || waiting.kind !== 'waiting') throw new Error('unexpected');
    expect(waiting.first.position).toBe(1);
    const outcome = waiting.wait({ signal: new AbortController().signal, onUpdate: () => {} });
    await held.lease.release();
    const result = await outcome;
    expect(result.kind).toBe('admitted');
    if (result.kind === 'admitted') {
      expect(result.lease.queued).toBe(true);
      await result.lease.release();
      await result.lease.release();
    }
  });

  it('times out, cancels on abort or a remote stop, and hands back when draining', async () => {
    let draining = false;
    const q = queue(new MemoryCapacityStore(), { draining: () => draining });
    await request(q);
    const timedOut = await request(q, 30);
    const aborted = await request(q);
    const remote = await request(q);
    const drained = await request(q);
    if (
      timedOut.kind !== 'waiting' ||
      aborted.kind !== 'waiting' ||
      remote.kind !== 'waiting' ||
      drained.kind !== 'waiting'
    )
      throw new Error('unexpected');
    const abort = new AbortController();
    const results: Promise<WaitOutcome>[] = [
      timedOut.wait({ signal: new AbortController().signal, onUpdate: () => {} }),
      aborted.wait({ signal: abort.signal, onUpdate: () => {} }),
      remote.wait({
        signal: new AbortController().signal,
        onUpdate: () => {},
        cancelRequested: async () => true,
      }),
    ];
    abort.abort();
    expect((await Promise.all(results)).map((r) => r.kind)).toEqual([
      'timeout',
      'cancelled',
      'cancelled',
    ]);
    const handed = drained.wait({ signal: new AbortController().signal, onUpdate: () => {} });
    draining = true;
    expect((await handed).kind).toBe('handoff');
    const already = new AbortController();
    already.abort();
    const late = await request(q);
    if (late.kind === 'waiting')
      expect((await late.wait({ signal: already.signal, onUpdate: () => {} })).kind).toBe(
        'cancelled',
      );
  });

  it('admits waiting turns at once when every limit is removed', async () => {
    let current: ProviderLimits | null = limits({ streams: 1 });
    const q = queue(new MemoryCapacityStore(), { limits: async () => current });
    await request(q);
    const waiting = await request(q);
    if (waiting.kind !== 'waiting') throw new Error('unexpected');
    const outcome = waiting.wait({ signal: new AbortController().signal, onUpdate: () => {} });
    current = null;
    expect((await outcome).kind).toBe('admitted');
  });

  it('falls back to this process’s store when the shared one fails', async () => {
    const failing = new MemoryCapacityStore();
    failing.enqueue = async () => {
      throw new Error('Redis down');
    };
    const local = new MemoryCapacityStore();
    const log = vi.fn();
    const q = queue(failing, { local, log });
    expect((await request(q)).kind).toBe('admitted');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed/), expect.anything());
    expect((await local.status('p')).activeStreams).toBe(1);
  });

  it('moves a wait to this process’s store when the shared one fails mid-wait', async () => {
    const shared = new MemoryCapacityStore();
    const local = new MemoryCapacityStore();
    const q = queue(shared, { local, log: () => {} });
    const held = await request(q);
    const waiting = await request(q);
    if (waiting.kind !== 'waiting' || held.kind !== 'admitted') throw new Error('unexpected');
    shared.poll = async () => {
      throw new Error('Redis down');
    };
    // The local store has room: the turn is admitted there.
    const outcome = await waiting.wait({
      signal: new AbortController().signal,
      onUpdate: () => {},
    });
    expect(outcome.kind).toBe('admitted');
  });

  it('settles the token estimate and counts extra requests', async () => {
    const store = new MemoryCapacityStore();
    const charge = vi.spyOn(store, 'charge');
    const q = queue(store, { limits: async () => limits({ tpm: 1_000 }) });
    const admitted = await q.request({
      id: 'settle',
      providerId: 'p',
      modelId: 'm',
      personId: 'x',
      tokens: 300,
      priorityOffsetMs: 0,
      maxWaitMs: 1_000,
    });
    if (admitted.kind !== 'admitted') throw new Error('unexpected');
    admitted.lease.chargeRequest();
    await admitted.lease.settle(null);
    await admitted.lease.settle(120);
    await admitted.lease.settle(120);
    expect(charge.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [1, 0],
      [0, -180],
    ]);
  });
});

describe('capacity settings', () => {
  it('reads malformed limits and queue settings as none and the defaults', () => {
    expect(normalizeLimits({ requestsPerMinute: -4 } as never)).toEqual({
      requestsPerMinute: null,
      tokensPerMinute: null,
      maxConcurrentStreams: null,
    });
    expect(normalizeLimits({ maxConcurrentStreams: 3 })).toMatchObject({
      maxConcurrentStreams: 3,
    });
    expect(
      normalizeQueueSettings({
        maxWaitSeconds: 1,
        rolePriority: { admin: 'high', user: 'x' as never },
      }),
    ).toEqual({
      maxWaitSeconds: 120,
      rolePriority: { admin: 'high', auditor: 'normal', user: 'normal', restricted: 'normal' },
    });
    expect(encodeLimits(limits({ rpm: 5 }, { m: { rpm: null, tpm: 7, streams: null } }))).toBe(
      '{"p":[5,-1,-1],"m":{"m":[-1,7,-1]}}',
    );
  });

  it('estimates a turn’s tokens from its input and reserved output', () => {
    expect(
      estimatedTurnTokens({
        uiMessages: [{ id: '1', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(300) }] }],
        system: '',
        resolved: { maxOutputTokens: 1_000 },
      }),
    ).toBeGreaterThan(1_100);
  });
});

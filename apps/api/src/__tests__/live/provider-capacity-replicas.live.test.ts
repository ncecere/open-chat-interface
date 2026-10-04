import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCapacityStore } from '../../services/limits/capacity/memory-store.js';
import {
  CapacityQueue,
  type CapacityRequest,
  type WaitOutcome,
} from '../../services/limits/capacity/queue.js';
import { RedisCapacityStore } from '../../services/limits/capacity/redis-store.js';
import type { ProviderLimits, StoreTimings } from '../../services/limits/capacity/store.js';

/**
 * Provider capacity across API replicas (v0.11 design, item 15): two
 * replicas, each with its own queue and its own Redis connection, as two
 * processes have, share one provider's limits. A replica that dies holding a
 * stream slot or a place in the queue frees them once their leases lapse.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6389';
const options = {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
};
async function redisAvailable() {
  const probe = new Redis(redisUrl, options);
  probe.on('error', () => {});
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}
const available = await redisAvailable();

const timings: Partial<StoreTimings> = { aliveMs: 800, leaseMs: 1_200, pickupMs: 800 };

describe.skipIf(!available)('live provider capacity across replicas', () => {
  const admin = new Redis(redisUrl, options);
  const clients: Redis[] = [];
  let providerId = '';
  let limits: ProviderLimits;

  function replica(overrides: { draining?: () => boolean } = {}) {
    const client = new Redis(redisUrl, options);
    client.on('error', () => {});
    clients.push(client);
    const store = new RedisCapacityStore(client, timings);
    const queue = new CapacityQueue({
      store: async () => store,
      local: new MemoryCapacityStore(timings),
      limits: async () => limits,
      draining: overrides.draining ?? (() => false),
      tickMs: 50,
      renewMs: 300,
    });
    return { client, store, queue };
  }
  let ids = 0;
  function ask(queue: CapacityQueue, personId: string, maxWaitMs = 10_000) {
    return queue.request({
      id: `turn-${++ids}-${personId}`,
      providerId,
      modelId: 'model-a',
      personId,
      tokens: 100,
      priorityOffsetMs: 0,
      maxWaitMs,
    });
  }
  function wait(request: CapacityRequest, signal = new AbortController().signal) {
    if (request.kind === 'admitted')
      return Promise.resolve({ kind: 'admitted', lease: request.lease } as WaitOutcome);
    return request.wait({ signal, onUpdate: () => {} });
  }

  beforeAll(async () => {
    await admin.connect();
  });
  afterEach(async () => {
    const keys = await admin.keys(`oci:capacity:{${providerId}}:*`);
    if (keys.length) await admin.del(...keys);
    for (const client of clients.splice(0)) client.disconnect();
  });
  afterAll(() => admin.disconnect());

  function fresh(streams: number | null, rpm: number | null = null) {
    providerId = `replicas-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    limits = {
      providerId,
      provider: { rpm, tpm: null, streams },
      models: {},
    };
  }

  it('holds one limit across two replicas and admits in queue order across them', async () => {
    fresh(2);
    const a = replica();
    const b = replica();
    await Promise.all([a.client.connect(), b.client.connect()]);
    const first = await ask(a.queue, 'p1');
    const second = await ask(b.queue, 'p2');
    expect(first.kind).toBe('admitted');
    expect(second.kind).toBe('admitted');
    // Both replicas are now full: the next turns wait, wherever they arrive.
    const third = await ask(a.queue, 'p3');
    const fourth = await ask(b.queue, 'p4');
    expect(third).toMatchObject({ kind: 'waiting', first: { position: 1 } });
    expect(fourth).toMatchObject({ kind: 'waiting', first: { position: 2 } });
    const order: string[] = [];
    const waits = [
      wait(third).then((outcome) => {
        order.push('third');
        return outcome;
      }),
      wait(fourth).then((outcome) => {
        order.push('fourth');
        return outcome;
      }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual([]);
    // A slot freed on replica B goes to the head of the queue, on replica A.
    if (second.kind === 'admitted') await second.lease.release();
    const [thirdOutcome] = await Promise.all([waits[0]]);
    expect(thirdOutcome?.kind).toBe('admitted');
    expect(order).toEqual(['third']);
    if (first.kind === 'admitted') await first.lease.release();
    const fourthOutcome = await waits[1];
    expect(fourthOutcome?.kind).toBe('admitted');
    expect(order).toEqual(['third', 'fourth']);
    expect(await admin.zcard(`oci:capacity:{${providerId}}:p:st`)).toBe(2);
  });

  it('frees a crashed replica’s stream slot when its lease lapses', async () => {
    fresh(1);
    const crashing = replica();
    const survivor = replica();
    await Promise.all([crashing.client.connect(), survivor.client.connect()]);
    const held = await ask(crashing.queue, 'p1');
    expect(held.kind).toBe('admitted');
    const waiting = await ask(survivor.queue, 'p2');
    expect(waiting.kind).toBe('waiting');
    // The replica dies: its connection goes, nothing is released or renewed.
    crashing.client.disconnect();
    const started = Date.now();
    const outcome = await wait(waiting);
    expect(outcome.kind).toBe('admitted');
    const freedAfter = Date.now() - started;
    expect(freedAfter).toBeGreaterThanOrEqual(600);
    expect(freedAfter).toBeLessThan(3_000);
  });

  it('drops a crashed replica’s waiting turns from the queue', async () => {
    fresh(1);
    const busy = replica();
    const crashing = replica();
    await Promise.all([busy.client.connect(), crashing.client.connect()]);
    const held = await ask(busy.queue, 'p1');
    const ghost = await ask(crashing.queue, 'p2');
    expect(ghost.kind).toBe('waiting');
    crashing.client.disconnect();
    crashing.queue.clear();
    const later = await ask(busy.queue, 'p3');
    expect(later).toMatchObject({ kind: 'waiting', first: { position: 2 } });
    // Once the ghost's ticket lapses, the live turn moves up and gets the slot.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (held.kind === 'admitted') await held.lease.release();
    expect((await wait(later)).kind).toBe('admitted');
    expect(await admin.zcard(`oci:capacity:{${providerId}}:q`)).toBe(0);
  });

  it('meters requests per minute across replicas with one bucket', async () => {
    fresh(null, 3);
    const a = replica();
    const b = replica();
    await Promise.all([a.client.connect(), b.client.connect()]);
    const outcomes = [
      await ask(a.queue, 'p1'),
      await ask(b.queue, 'p2'),
      await ask(a.queue, 'p3'),
      await ask(b.queue, 'p4', 5_000),
    ];
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      'admitted',
      'admitted',
      'admitted',
      'waiting',
    ]);
    // Three a minute refill one every 20 seconds; the fourth is next in line.
    const status = await b.store.status(providerId);
    expect(status.queued).toBe(1);
    const fourth = outcomes[3]!;
    if (fourth.kind === 'waiting') {
      const abort = new AbortController();
      abort.abort();
      expect((await wait(fourth, abort.signal)).kind).toBe('cancelled');
    }
    expect((await b.store.status(providerId)).queued).toBe(0);
  });

  it('hands waiting turns back when the replica drains, keeping their place', async () => {
    fresh(1);
    let draining = false;
    const a = replica({ draining: () => draining });
    await a.client.connect();
    const held = await ask(a.queue, 'p1');
    const queued = await ask(a.queue, 'p2');
    expect(held.kind).toBe('admitted');
    const pending = wait(queued);
    draining = true;
    const outcome = await pending;
    expect(outcome.kind).toBe('handoff');
    expect(await admin.zcard(`oci:capacity:{${providerId}}:q`)).toBe(0);
    // Sent again elsewhere with its tag, it goes before a newer turn.
    const b = replica();
    await b.client.connect();
    const newerId = `turn-${ids + 1}-p3`;
    const newer = await ask(b.queue, 'p3');
    const again = await b.queue.request({
      id: 'again',
      providerId,
      modelId: 'model-a',
      personId: 'p2',
      tokens: 100,
      priorityOffsetMs: 0,
      maxWaitMs: 5_000,
      handoffTag: outcome.kind === 'handoff' ? outcome.tag : null,
    });
    expect(newer).toMatchObject({ kind: 'waiting', first: { position: 1 } });
    expect(again).toMatchObject({ kind: 'waiting', first: { position: 1 } });
    const statuses = await b.store.poll(limits, [newerId, 'again']);
    expect(statuses.get('again')).toMatchObject({ state: 'waiting', position: 1 });
    expect(statuses.get(newerId)).toMatchObject({ state: 'waiting', position: 2 });
    b.queue.clear();
  });
});

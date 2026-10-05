import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cache bus (v0.11 design, item 20) without a server: a fake subscriber
 * connection that connects, drops and comes back, and a fake publisher. What
 * matters most here: messages published while a replica was not subscribed
 * are lost, so subscribing again clears every cache; a replica ignores its
 * own messages; nothing it hears can throw.
 */
const state = vi.hoisted(() => ({
  redisUrl: 'redis://fake:6379' as string | undefined,
  subscriber: null as unknown,
  publisher: null as null | { publish: ReturnType<typeof vi.fn> },
  failConnect: false,
}));

class FakeSubscriber extends EventEmitter {
  status = 'wait';
  subscribe = vi.fn(async (_channel: string) => 1);
  connect = vi.fn(async () => {
    if (state.failConnect) throw new Error('ECONNREFUSED');
    this.status = 'ready';
    this.emit('ready');
  });
  quit = vi.fn(async () => 'OK');
  disconnect = vi.fn();
}

vi.mock('../../lib/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/redis.js')>()),
  createRedisClient: () => {
    if (!state.redisUrl) return null;
    const client = new FakeSubscriber();
    state.subscriber = client;
    return client;
  },
}));
vi.mock('../../services/chat-streams.js', () => ({
  sharedRedisClient: async () => state.publisher,
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => 'org-1',
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return { ...original, loadEnv: () => ({ ...original.loadEnv(), REDIS_URL: state.redisUrl }) };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const bus = await import('../../services/cache-bus/index.js');
const { instanceId } = await import('../../lib/instance.js');

const cleared: Array<string | undefined> = [];
const otherCleared: Array<string | undefined> = [];

beforeEach(() => {
  state.redisUrl = 'redis://fake:6379';
  state.publisher = { publish: vi.fn(async () => 1) };
  cleared.length = 0;
  otherCleared.length = 0;
  bus.onCacheInvalidation('settings', (key) => cleared.push(key));
  bus.onCacheInvalidation('webhooks', (key) => otherCleared.push(key));
});
afterEach(() => vi.clearAllMocks());

const fake = () => state.subscriber as FakeSubscriber;
const message = (body: unknown) =>
  fake().emit('message', 'oci:cache-invalidate:org-1', JSON.stringify(body));

describe('cache bus', () => {
  it('subscribes to the instance channel and applies what other replicas publish', async () => {
    const stop = await bus.startCacheBus();
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('listening'));
    expect(fake().subscribe).toHaveBeenCalledWith('oci:cache-invalidate:org-1');
    expect(otherCleared).toEqual([]);

    message({ cache: 'settings', key: 'features', from: 'another-replica' });
    message({ cache: 'webhooks', from: 'another-replica' });
    expect(cleared).toEqual(['features']);
    expect(otherCleared).toEqual([undefined]);

    // Its own, malformed, unknown and other channels' messages change nothing.
    message({ cache: 'settings', key: 'auth', from: instanceId });
    message({ cache: 'nonsense', from: 'another-replica' });
    message({ from: 'another-replica' });
    fake().emit('message', 'oci:cache-invalidate:org-1', '{not json');
    fake().emit('message', 'some-other-channel', JSON.stringify({ cache: 'settings' }));
    expect(cleared).toEqual(['features']);
    expect(bus.cacheBusCounts().received).toBe(2);

    await stop();
    expect(fake().quit).toHaveBeenCalled();
    expect(bus.cacheBusStatus()).toBe('unconfigured');
  });

  it('clears every cache when it subscribes again after being away', async () => {
    const stop = await bus.startCacheBus();
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('listening'));
    fake().emit('close');
    expect(bus.cacheBusStatus()).toBe('unavailable');
    expect(cleared).toEqual([]);
    // Back: whatever was published meanwhile is lost, so start from the database.
    fake().emit('ready');
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('listening'));
    expect(cleared).toEqual([undefined]);
    expect(otherCleared).toEqual([undefined]);
    fake().emit('end');
    expect(bus.cacheBusStatus()).toBe('unavailable');
    await stop();
  });

  it('keeps going when a cache cannot be cleared, or subscribing fails', async () => {
    bus.onCacheInvalidation('settings', () => {
      throw new Error('broken');
    });
    const stop = await bus.startCacheBus();
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('listening'));
    expect(() => message({ cache: 'settings', from: 'another-replica' })).not.toThrow();
    fake().subscribe.mockRejectedValueOnce(new Error('NOAUTH'));
    fake().emit('ready');
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('unavailable'));
    await stop();
  });

  it('marks itself unavailable when the first connection fails', async () => {
    state.failConnect = true;
    const stop = await bus.startCacheBus();
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('unavailable'));
    state.failConnect = false;
    await stop();
  });

  it('is unconfigured without Redis, and publishing then does nothing', async () => {
    state.redisUrl = undefined;
    const stop = await bus.startCacheBus();
    expect(bus.cacheBusStatus()).toBe('unconfigured');
    await bus.publishInvalidation('settings', 'features');
    expect(state.publisher?.publish).not.toHaveBeenCalled();
    expect(await bus.cacheBusHealthCheck()).toMatchObject({ status: 'ok' });
    await stop();
  });

  it('publishes with this replica as the sender, and survives Redis being away', async () => {
    await bus.publishInvalidation('settings', 'features');
    expect(state.publisher?.publish).toHaveBeenCalledWith(
      'oci:cache-invalidate:org-1',
      JSON.stringify({ cache: 'settings', key: 'features', from: instanceId }),
    );
    await bus.publishInvalidation('webhooks');
    expect(state.publisher?.publish).toHaveBeenLastCalledWith(
      'oci:cache-invalidate:org-1',
      JSON.stringify({ cache: 'webhooks', from: instanceId }),
    );
    const failures = bus.cacheBusCounts().publishFailures;
    state.publisher = {
      publish: vi.fn(async () => Promise.reject(new Error('Connection is closed'))),
    };
    await expect(bus.publishInvalidation('settings')).resolves.toBeUndefined();
    state.publisher = null;
    await expect(bus.publishInvalidation('settings')).resolves.toBeUndefined();
    expect(bus.cacheBusCounts().publishFailures).toBe(failures + 2);
  });

  it('reports its state on System health', async () => {
    const stop = await bus.startCacheBus();
    await vi.waitFor(() => expect(bus.cacheBusStatus()).toBe('listening'));
    expect(await bus.cacheBusHealthCheck()).toMatchObject({ status: 'ok' });
    fake().emit('close');
    expect(await bus.cacheBusHealthCheck()).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('within 30 seconds'),
    });
    await stop();
  });
});

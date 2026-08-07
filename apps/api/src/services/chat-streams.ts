import Redis from 'ioredis';
import { loadEnv } from '../config/env.js';
import { logger } from '../lib/logger.js';

const KEY_PREFIX = 'oci:chat-stream';
const MAX_EVENTS = 10_000;
const RESUME_POLL_MS = 100;
const REDIS_RETRY_DELAY_MS = 30_000;

export type ChatRunStatus = 'active' | 'complete' | 'error' | 'cancelled';

interface ChatRunIdentity {
  runId: string;
  threadId: string;
  userId: string;
}

interface ChatRunOutcome {
  status: Exclude<ChatRunStatus, 'active'>;
  error?: string;
}

export type BeginChatRunResult = 'available' | 'unavailable' | 'conflict';

function activeKey(threadId: string) {
  return `${KEY_PREFIX}:thread:${threadId}:active`;
}

function metadataKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:metadata`;
}

function eventsKey(runId: string) {
  return `${KEY_PREFIX}:run:${runId}:events`;
}

function fieldsToRecord(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}

/** Redis persistence for one bounded, owner-scoped AI SDK SSE stream. */
export class ChatStreamStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async begin(identity: ChatRunIdentity): Promise<'available' | 'conflict'> {
    const active = activeKey(identity.threadId);
    const acquired = await this.redis.set(active, identity.runId, 'EX', this.ttlSeconds, 'NX');
    if (acquired !== 'OK') return 'conflict';

    try {
      await this.redis
        .multi()
        .hset(metadataKey(identity.runId), {
          runId: identity.runId,
          threadId: identity.threadId,
          userId: identity.userId,
          status: 'active',
          expiresAt: String(Date.now() + this.ttlSeconds * 1000),
        })
        .expire(metadataKey(identity.runId), this.ttlSeconds)
        .exec();
      return 'available';
    } catch (error) {
      await this.redis.del(active).catch(() => undefined);
      throw error;
    }
  }

  async abandon(identity: ChatRunIdentity): Promise<void> {
    await this.finalize(identity, { status: 'error', error: 'Stream setup failed' });
  }

  async requestCancellation(identity: ChatRunIdentity): Promise<boolean> {
    const metadata = await this.redis.hgetall(metadataKey(identity.runId));
    if (metadata.threadId !== identity.threadId || metadata.userId !== identity.userId)
      return false;

    await this.redis.hset(metadataKey(identity.runId), 'cancelRequested', '1');
    return true;
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    return (await this.redis.hget(metadataKey(runId), 'cancelRequested')) === '1';
  }

  async append(runId: string, value: string): Promise<void> {
    const key = eventsKey(runId);
    const expiresAt = Number(await this.redis.hget(metadataKey(runId), 'expiresAt'));
    if (!Number.isFinite(expiresAt)) throw new Error('Chat stream metadata expired');

    const remainingSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    await this.redis
      .multi()
      .xadd(key, 'MAXLEN', '~', MAX_EVENTS, '*', 'data', value)
      .expire(key, remainingSeconds)
      .exec();
  }

  async finalize(identity: ChatRunIdentity, outcome: ChatRunOutcome): Promise<void> {
    const metadata = await this.redis.hgetall(metadataKey(identity.runId));
    if (metadata.threadId !== identity.threadId || metadata.userId !== identity.userId) return;

    const active = activeKey(identity.threadId);
    const transaction = this.redis.multi().hset(metadataKey(identity.runId), {
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
    });

    if ((await this.redis.get(active)) === identity.runId) transaction.del(active);
    await transaction.exec();
  }

  async activeRun(threadId: string, userId: string): Promise<ChatRunIdentity | null> {
    const runId = await this.redis.get(activeKey(threadId));
    if (!runId) return null;

    const metadata = await this.redis.hgetall(metadataKey(runId));
    if (
      metadata.status !== 'active' ||
      metadata.threadId !== threadId ||
      metadata.userId !== userId
    ) {
      return null;
    }

    return { runId, threadId, userId };
  }

  /** Replays from the beginning, then tails until the producer finalizes. */
  createReplayStream(identity: ChatRunIdentity, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let cancelled = false;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        void (async () => {
          let lastId = '0-0';
          try {
            while (!cancelled && !signal?.aborted) {
              const metadata = await this.redis.hgetall(metadataKey(identity.runId));
              if (metadata.threadId !== identity.threadId || metadata.userId !== identity.userId) {
                break;
              }

              const rows = (await this.redis.xrange(
                eventsKey(identity.runId),
                `(${lastId}`,
                '+',
                'COUNT',
                200,
              )) as Array<[string, string[]]>;

              for (const [id, fields] of rows) {
                lastId = id;
                const value = fieldsToRecord(fields).data;
                if (value !== undefined) controller.enqueue(encoder.encode(value));
              }

              if (metadata.status !== 'active' && rows.length === 0) break;
              if (rows.length === 0) {
                await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
              }
            }
            if (!cancelled) controller.close();
          } catch (error) {
            if (!cancelled && !signal?.aborted) controller.error(error);
          }
        })();
      },
      cancel: () => {
        cancelled = true;
      },
    });
  }
}

let runtimeStore: ChatStreamStore | null = null;
let redisClient: Redis | null = null;
let redisUnavailableUntil = 0;

async function runtimeChatStreamStore(): Promise<ChatStreamStore | null> {
  const env = loadEnv();
  if (!env.REDIS_URL || Date.now() < redisUnavailableUntil) return null;
  if (runtimeStore) return runtimeStore;

  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();
    redisClient = client;
    runtimeStore = new ChatStreamStore(client, env.CHAT_STREAM_TTL_SECONDS);
    return runtimeStore;
  } catch (error) {
    redisUnavailableUntil = Date.now() + REDIS_RETRY_DELAY_MS;
    client.disconnect();
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis connection failed' },
      'Resumable chat streams unavailable',
    );
    return null;
  }
}

async function withStore<T>(operation: (store: ChatStreamStore) => Promise<T>): Promise<T | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    return await operation(store);
  } catch (error) {
    redisUnavailableUntil = Date.now() + REDIS_RETRY_DELAY_MS;
    runtimeStore = null;
    redisClient?.disconnect();
    redisClient = null;
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Resumable chat stream persistence failed',
    );
    return null;
  }
}

const localRuns = new Map<string, { identity: ChatRunIdentity; abort: AbortController }>();

/**
 * Reports whether resumable streams are actually working, reusing the shared
 * connection rather than opening a second one. `disabled` means no REDIS_URL is
 * configured; `error` means one is configured but unreachable, which is worth
 * surfacing because streams silently fall back to non-resumable.
 */
export async function chatStreamRedisStatus(): Promise<'ok' | 'error' | 'disabled'> {
  if (!loadEnv().REDIS_URL) return 'disabled';
  return (await runtimeChatStreamStore()) ? 'ok' : 'error';
}

export async function beginChatRun(identity: ChatRunIdentity): Promise<BeginChatRunResult> {
  const result = await withStore((store) => store.begin(identity));
  return result ?? 'unavailable';
}

export async function abandonChatRun(identity: ChatRunIdentity): Promise<void> {
  await withStore((store) => store.abandon(identity));
}

export function registerLocalChatRun(identity: ChatRunIdentity, abort: AbortController): void {
  localRuns.set(identity.runId, { identity, abort });
}

export function unregisterLocalChatRun(runId: string): void {
  localRuns.delete(runId);
}

export async function isChatRunCancellationRequested(runId: string): Promise<boolean> {
  return (await withStore((store) => store.cancellationRequested(runId))) ?? false;
}

export async function cancelActiveChatRun(threadId: string, userId: string): Promise<boolean> {
  const local = [...localRuns.values()].find(
    (run) => run.identity.threadId === threadId && run.identity.userId === userId,
  );
  if (local) local.abort.abort('user-stop');

  const active = await withStore((store) => store.activeRun(threadId, userId));
  if (active) await withStore((store) => store.requestCancellation(active));
  return Boolean(local || active);
}

export async function resumeActiveChatRun(
  threadId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; persistence: 'redis' } | null> {
  const store = await runtimeChatStreamStore();
  if (!store) return null;

  try {
    const identity = await store.activeRun(threadId, userId);
    if (!identity) return null;
    return { stream: store.createReplayStream(identity, signal), persistence: 'redis' };
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Could not resume chat stream',
    );
    return null;
  }
}

export async function captureChatRun(
  identity: ChatRunIdentity,
  stream: ReadableStream<string>,
  getOutcome: () => ChatRunOutcome,
): Promise<void> {
  const reader = stream.getReader();
  let persistenceFailed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (persistenceFailed) continue;

      const stored = await withStore(async (store) => {
        await store.append(identity.runId, value);
        return true;
      });
      if (!stored) persistenceFailed = true;
    }
  } catch (error) {
    persistenceFailed = true;
    logger.warn(
      {
        err: error instanceof Error ? error.message : 'Stream capture failed',
        runId: identity.runId,
      },
      'Chat stream capture failed',
    );
  } finally {
    reader.releaseLock();
    const outcome = persistenceFailed
      ? { status: 'error' as const, error: 'Stream persistence failed' }
      : getOutcome();
    await withStore((store) => store.finalize(identity, outcome));
    unregisterLocalChatRun(identity.runId);
  }
}

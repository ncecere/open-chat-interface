import { logger } from '../../lib/logger.js';
import type { OwnedRunState } from '../chat/run-state.js';
import { type ReplayValidator, validateReplayRun } from '../chat-replay-validation.js';
import { runtimeChatStreamStore, storeAfterReconnect } from './connection.js';
import type { ChatRunIdentity } from './types.js';

const replayReaders = new Set<AbortController>();

/** Replay readers this process is still sending to (shutdown waits briefly for them). */
export function chatReplayCount(): number {
  return replayReaders.size;
}

/** Ends this process's replay readers cleanly (shutdown); their clients resume elsewhere. */
export function endChatReplays(): number {
  const count = replayReaders.size;
  for (const reader of replayReaders) reader.abort();
  replayReaders.clear();
  return count;
}

export async function resumeActiveChatRun(
  threadId: string,
  userId: string,
  signal?: AbortSignal,
  options?: {
    readState: (identity: ChatRunIdentity, signal: AbortSignal) => Promise<OwnedRunState>;
  },
): Promise<{ stream: ReadableStream<Uint8Array>; persistence: 'redis'; runId: string } | null> {
  const store = (await runtimeChatStreamStore()) ?? (await storeAfterReconnect(signal));
  if (!store) return null;

  let identity: ChatRunIdentity | null;
  try {
    identity = await store.activeRun(threadId, userId);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : 'Redis operation failed' },
      'Could not resume chat stream',
    );
    return null;
  }
  if (!identity) return null;
  const owned = identity;
  const readState: ReplayValidator<OwnedRunState> | undefined = options
    ? (checkSignal) => options.readState(owned, checkSignal)
    : undefined;
  // Durable validation failures are not cache absence: let the route report a
  // safe retryable failure rather than silently returning 204 or opening SSE.
  if (readState && (await validateReplayRun(readState, signal)) !== 'streaming') return null;
  const ending = new AbortController();
  replayReaders.add(ending);
  const scoped = signal ? AbortSignal.any([signal, ending.signal]) : ending.signal;
  return {
    stream: store.createReplayStream(owned, scoped, {
      readState,
      // A reader is also how a reply whose producer died gets noticed: it
      // ends the run as interrupted, then finishes with what was captured.
      ...(readState && {
        checkProducer: async () => {
          const { recoverInterruptedRun } = await import('../chat/run-recovery.js');
          return recoverInterruptedRun(owned);
        },
      }),
      onEnd: () => replayReaders.delete(ending),
    }),
    persistence: 'redis',
    runId: owned.runId,
  };
}

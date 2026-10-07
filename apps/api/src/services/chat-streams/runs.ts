import { withStore } from './connection.js';
import type { BeginChatRunResult, BeginOptions, ChatRunIdentity } from './types.js';

const localRuns = new Map<string, { identity: ChatRunIdentity; abort: AbortController }>();

export async function beginChatRun(
  identity: ChatRunIdentity,
  options?: BeginOptions,
): Promise<BeginChatRunResult> {
  const result = await withStore((store) => store.begin(identity, options));
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

/** The producer heartbeat (v0.11); best effort, like every cache write. */
export async function touchChatRunHeartbeat(runId: string, ttlMs: number): Promise<void> {
  await withStore((store) => store.touchAlive(runId, ttlMs));
}

/** Null when Redis is unavailable, so the caller decides from PostgreSQL alone. */
export async function chatRunProducerActive(
  runId: string,
  windowMs: number,
): Promise<boolean | null> {
  return withStore((store) => store.producerActive(runId, windowMs));
}

export async function capturedChatRunFrames(runId: string): Promise<string[] | null> {
  return withStore((store) => store.capturedFrames(runId));
}

export async function activeChatRunId(threadId: string): Promise<string | null> {
  return withStore((store) => store.activeRunId(threadId));
}

/**
 * Ends a run's cached stream as cancelled for a producer that is gone, so
 * every replay reader finishes with what was captured instead of waiting.
 */
export async function finalizeInterruptedChatRun(
  identity: ChatRunIdentity,
  error: string,
): Promise<void> {
  await withStore((store) => store.finalize(identity, { status: 'cancelled', error }));
}

export async function isChatRunCancellationRequested(runId: string): Promise<boolean> {
  return (await withStore((store) => store.cancellationRequested(runId))) ?? false;
}

export async function cancelActiveChatRun(threadId: string, userId: string): Promise<boolean> {
  // Registration follows durable admission. An older terminal run may still be
  // settling usage; explicit Stop must target the newer local producer, not it.
  const local = [...localRuns.values()]
    .reverse()
    .find((run) => run.identity.threadId === threadId && run.identity.userId === userId);
  if (local) local.abort.abort('user-stop');

  const active = await withStore((store) => store.activeRun(threadId, userId));
  const requested = active ? await withStore((store) => store.requestCancellation(active)) : false;
  return Boolean(local || requested);
}

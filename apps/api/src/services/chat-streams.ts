/**
 * Resumable chat streams: the entry point. The implementation lives in
 * `chat-streams/`:
 *
 * - `types.ts`: a run's identity, outcome and status types.
 * - `keys.ts`: the Redis key layout, event bound and shared scripts.
 * - `store.ts`: `ChatStreamStore`, Redis persistence for one reply's stream.
 * - `connection.ts`: the one shared Redis client, its readiness and `withStore`.
 * - `runs.ts`: this process's running replies and per-run operations.
 * - `resume.ts`: replay readers and resuming an active reply.
 * - `capture.ts`: capturing a reply's frames, through a Redis failover.
 */
export { captureChatRun, captureRecovery } from './chat-streams/capture.js';
export {
  chatStreamRedisStatus,
  closeChatStreams,
  noteRedisFailure,
  redisConfigured,
  resumeWait,
  sharedRedis,
  sharedRedisClient,
} from './chat-streams/connection.js';
export { MAX_EVENTS } from './chat-streams/keys.js';
export { chatReplayCount, endChatReplays, resumeActiveChatRun } from './chat-streams/resume.js';
export {
  abandonChatRun,
  activeChatRunId,
  beginChatRun,
  cancelActiveChatRun,
  capturedChatRunFrames,
  chatRunProducerActive,
  chatRunProducerQuietIn,
  finalizeInterruptedChatRun,
  isChatRunCancellationRequested,
  registerLocalChatRun,
  touchChatRunHeartbeat,
  unregisterLocalChatRun,
} from './chat-streams/runs.js';
export { ChatStreamStore } from './chat-streams/store.js';
export type { BeginChatRunResult, ChatRunStatus } from './chat-streams/types.js';

import type { UIMessage } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '~/lib/api-client';
import {
  getChatHistory,
  hasPendingReply,
  mergeLatest,
  messageStatus,
  refreshLimit,
} from '~/lib/chat-history';

interface RecoveryChat {
  status: string;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[] | ((current: UIMessage[]) => UIMessage[])) => void;
  clearError: () => void;
  resumeStream: () => Promise<void>;
}
export interface ChatConnectionScope {
  active: boolean;
  request: number;
}
const live = (status: string) => status === 'streaming' || status === 'submitted';

const CHECK_INTERVAL_MS = 2000;
const MAX_CHECK_INTERVAL_MS = 15_000;
/**
 * A check that failed because the server could not be reached or answered
 * with a passing error (the API crashed or restarted, a proxy's 502/503/504,
 * a dropped network): the reply may still be saved there, so keep checking
 * (#229). A refused or malformed answer is not transient.
 */
const transientFailure = (failure: unknown) =>
  failure instanceof TypeError ||
  (failure instanceof ApiError && (failure.status >= 500 || [408, 429].includes(failure.status)));
export const RECOVERY_RETRYING_TEXT =
  'Could not reach the server to check for the reply. Checking again automatically.';
export const RECOVERY_FAILED_TEXT =
  'Could not read the saved messages. Use Reload saved messages to check again.';

/** Reconnect once; recover from canonical storage without resending or losing the composer. */
export function useChatRecovery(options: {
  threadId: string;
  initialMessages?: UIMessage[];
  chat: RecoveryChat;
  runId: string | null;
  clearRun: (runId: string) => void;
  scope: ChatConnectionScope;
  onCanonicalMessages?: (messages: UIMessage[]) => void;
}) {
  const [initialPending] = useState(() => hasPendingReply(options.initialMessages ?? []));
  const [resuming, setResuming] = useState(initialPending);
  const [remotePending, setRemotePending] = useState(initialPending);
  const [watch, setWatch] = useState<number | null>(() =>
    initialPending ? options.scope.request : null,
  );
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  // Checks failed in a row while the server was unreachable: the next waits
  // longer, up to MAX_CHECK_INTERVAL_MS, until one succeeds (#229).
  const failuresRef = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The person pressed Stop and the server has not saved the stopped reply
  // yet: the page says "Stopping…", not that a reply is pending (#154).
  const [stopRequested, setStopRequested] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const resumeRequest = useRef<Promise<void> | null>(null);
  const { status, resumeStream } = options.chat;

  useEffect(() => {
    if (!initialPending) return;
    let disposed = false;
    const request = latest.current.scope.request;
    // Strict Mode may repeat effect setup; attach to the same reconnect, rather
    // than running two SDK writers against a single message state.
    resumeRequest.current ??= resumeStream().catch(() => undefined);
    void resumeRequest.current.then(() => {
      if (!disposed) {
        setResuming(false);
        setWatch(request);
      }
    });
    return () => {
      disposed = true;
    };
  }, [initialPending, resumeStream]);

  const recover = useCallback(() => {
    setWatch(latest.current.scope.request);
    setAttempt(++attemptRef.current);
  }, []);
  const waitForServer = useCallback(() => {
    setRemotePending(true);
    setWatch(latest.current.scope.request);
    setAttempt(++attemptRef.current);
  }, []);
  /** As waitForServer, after the person asked the server to stop the reply. */
  const waitForStop = useCallback(() => {
    setStopRequested(true);
    waitForServer();
  }, [waitForServer]);

  useEffect(() => {
    // A refresh requested before a new send must not become permission to
    // replace that newer request's rejected/unsaved optimistic prompt.
    if (watch !== null && watch !== options.scope.request) {
      setWatch(null);
    }
    if (
      resuming ||
      live(status) ||
      (watch !== options.scope.request && !(options.runId && status === 'error'))
    ) {
      setRefreshing(false);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = (delay = CHECK_INTERVAL_MS) => {
      timer = setTimeout(() => {
        void refresh();
      }, delay);
    };
    async function refresh() {
      const before = latest.current;
      if (
        disposed ||
        attemptRef.current !== attempt ||
        before.threadId !== options.threadId ||
        live(before.chat.status)
      )
        return;
      const version = before.scope.request;
      const baseline = before.chat.messages;
      setRefreshing(true);
      try {
        // The latest page, reaching back past the first message on screen
        // (older pages are kept apart from the live part; v0.11).
        const snapshot = await getChatHistory(before.threadId, controller.signal, {
          limit: refreshLimit(baseline.length),
        });
        if (
          disposed ||
          attemptRef.current !== attempt ||
          before.scope.request !== version ||
          live(latest.current.chat.status)
        )
          return;
        if (snapshot.thread.id !== before.threadId)
          throw new Error('Unexpected conversation response');
        // The SDK setter evaluates its updater against current state, not the
        // React render that started this request. A newer send/stream wins.
        let applied = false;
        latest.current.chat.setMessages((current) => {
          if (current !== baseline || before.scope.request !== version) return current;
          applied = true;
          const previous = new Map(current.map((message) => [message.id, message]));
          return mergeLatest(current, snapshot.messages).map((message) => {
            const local = previous.get(message.id);
            // A durable streaming claim usually has empty parts. Keep a prefix
            // already received by this reader until the terminal message is saved.
            return message.role === 'assistant' &&
              messageStatus(message) === 'streaming' &&
              local?.role === 'assistant'
              ? local
              : message;
          });
        });
        if (!applied) {
          schedule();
          return;
        }
        failuresRef.current = 0;
        latest.current.onCanonicalMessages?.(snapshot.messages);
        const pending = hasPendingReply(snapshot.messages);
        setRemotePending(pending);
        if (!pending) setStopRequested(false);
        setUnavailable(false);
        setError(null);
        if (pending) schedule();
        else {
          setWatch(null);
          if (before.runId) before.clearRun(before.runId);
          // A saved failed reply says so itself, with its reason and Retry
          // (ReplyFailureNote); a second notice here said neither (#133).
          latest.current.chat.clearError();
        }
      } catch (failure) {
        if (
          disposed ||
          attemptRef.current !== attempt ||
          before.scope.request !== version ||
          live(latest.current.chat.status)
        )
          return;
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          setUnavailable(true);
          setRemotePending(false);
          setError('Conversation unavailable');
        } else if (transientFailure(failure)) {
          // One failed check while the API is down used to end recovery for
          // good, leaving "A reply is pending" and Stop on screen after the
          // server had saved the reply (#229). Keep the run and the watch,
          // and check again with backoff until the server answers.
          failuresRef.current++;
          setError(RECOVERY_RETRYING_TEXT);
          schedule(Math.min(CHECK_INTERVAL_MS * 2 ** failuresRef.current, MAX_CHECK_INTERVAL_MS));
          return;
        } else setError(RECOVERY_FAILED_TEXT);
        failuresRef.current = 0;
        setWatch(null);
        setStopRequested(false);
        if (before.runId) before.clearRun(before.runId);
      } finally {
        if (!disposed) setRefreshing(false);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [options.threadId, options.runId, options.scope.request, status, watch, attempt, resuming]);

  return {
    resuming,
    remotePending,
    stopping: stopRequested && remotePending,
    refreshing,
    unavailable,
    error,
    recover,
    waitForServer,
    waitForStop,
  };
}

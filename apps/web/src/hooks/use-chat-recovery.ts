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
  const [refreshing, setRefreshing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    const schedule = () => {
      timer = setTimeout(() => {
        void refresh();
      }, 2000);
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
        latest.current.onCanonicalMessages?.(snapshot.messages);
        const pending = hasPendingReply(snapshot.messages);
        setRemotePending(pending);
        setUnavailable(false);
        setError(null);
        if (pending) schedule();
        else {
          setWatch(null);
          if (before.runId) before.clearRun(before.runId);
          latest.current.chat.clearError();
          const lastReply = snapshot.messages.findLast((message) => message.role === 'assistant');
          if (lastReply && messageStatus(lastReply) === 'error')
            setError('The saved response ended with an error. You can retry the message.');
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
        } else setError('Could not refresh saved messages. Retry to check the response.');
        setWatch(null);
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

  return { resuming, remotePending, refreshing, unavailable, error, recover, waitForServer };
}

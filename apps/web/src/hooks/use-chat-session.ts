import { useChat } from '@ai-sdk/react';
import type { Attachment, CatalogModel, ReasoningEffort } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { capacityWaitOf } from '~/components/chat/capacity-wait';
import { useAttachments } from '~/hooks/use-attachments';
import { useChatRecovery } from '~/hooks/use-chat-recovery';
import { useComposerEffort } from '~/hooks/use-composer-effort';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { fetchRetryingDrain } from '~/lib/chat-retry';
import {
  confirmedAttachmentIds,
  confirmPromptId,
  readChatSubmission,
  readRefusedSubmission,
} from '~/lib/chat-submission';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import { reasoningEffortForRequest } from '~/lib/reasoning';
import { startingModel } from '~/lib/starting-model';
import { requestStop } from '~/lib/stop-request';
import { approvalResponsesOf, denyUnansweredApprovals } from '~/lib/tool-approvals';

const EMPTY_MODELS: CatalogModel[] = [];

/** The API's answer to a failed send: `no` when the message cannot have been stored (#326). */
const MESSAGE_SAVED_HEADER = 'X-OCI-Message-Saved';
/**
 * Said when the saved messages show that a message whose send failed was not
 * stored (#326). Not why: a lost database, a proxy's 502 or a dropped
 * connection end the same way.
 */
export const UNSAVED_MESSAGE_TEXT =
  'Your message could not be saved, so it is back in the message box. Send it again.';

/**
 * A user message among the saved ones that was not there before the send,
 * with the same text (the server stores each text part trimmed, and may give
 * the message an ID of its own).
 */
function savedAsNew(saved: UIMessage[], sent: { text: string; known: Set<string> }): boolean {
  const text = sent.text.trim();
  return saved.some(
    (message) =>
      message.role === 'user' &&
      !sent.known.has(message.id) &&
      message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text.trim()] : []))
        .join('\n') === text,
  );
}

/**
 * This browser's time zone, sent with each turn so the model is told today's
 * date where the person is, not where the instance is (#248). Read per send:
 * a laptop can travel. Absent when the browser does not say.
 */
function browserTimeZone(): { timeZone?: string } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? { timeZone: zone } : {};
  } catch {
    return {};
  }
}
/** Times a turn handed back by a server shutting down is sent again in a row. */
const HANDOFF_RETRIES = 2;

/**
 * Owns composer state, model selection, and the streaming connection for one
 * thread. Shared by the landing page and the thread view so behaviour cannot
 * drift between them.
 */
export function useChatSession(options: {
  threadId: string;
  initialMessages?: UIMessage[];
  carriedAttachments?: Attachment[];
  initialModelSlug?: string | null;
  initialEffort?: ReasoningEffort;
  initialWebSearch?: boolean;
  temporary?: boolean;
}) {
  const queryClient = useQueryClient();
  const modelsQuery = useModels();
  const models = modelsQuery.data ?? EMPTY_MODELS;
  const { data: currentUser } = useCurrentUser();
  const scope = useMemo(
    () => ({
      active: true,
      lifetime: 0,
      request: 0,
      threadId: options.threadId,
      runId: null as string | null,
      reconnectAbort: null as AbortController | null,
    }),
    [options.threadId],
  );
  const [runId, setRunId] = useState<string | null>(null);
  // The last message sent was refused before it was saved (nothing of it is
  // on the server): no saved messages to reload, and a conversation whose
  // only message it was is still unused (#234).
  const [refused, setRefused] = useState(false);
  // Said when a message whose send failed turned out not to be saved (#326).
  const [notice, setNotice] = useState<string | null>(null);
  const requestRecovery = useRef<() => void>(() => {});
  // Turns handed back by a server shutting down, sent again in a row (v0.11).
  const handoffRetries = useRef(0);
  const sendAgain = useRef<() => void>(() => {});
  const acceptSubmission = useRef<
    (
      submission: NonNullable<ReturnType<typeof readChatSubmission>>,
      promptId: string | null,
    ) => void
  >(() => {});
  const refuseSubmission = useRef<
    (refused: NonNullable<ReturnType<typeof readRefusedSubmission>>) => void
  >(() => {});
  const checkSubmission = useRef<
    (sent: NonNullable<ReturnType<typeof readRefusedSubmission>>) => void
  >(() => {});
  // A message whose send failed after it may have been stored (#326): its
  // text, and the messages on screen before it.
  const unconfirmed = useRef<{ text: string; known: Set<string> } | null>(null);
  const clearRun = useCallback(
    (id: string) => setRunId((current) => (current === id ? null : current)),
    [],
  );
  const fetchChat = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const sending = init?.method?.toUpperCase() === 'POST';
      const request = sending ? ++scope.request : scope.request;
      if (sending) {
        scope.runId = null;
        setRunId(null);
        setRefused(false);
        setNotice(null);
        unconfirmed.current = null;
      }
      let signal = init?.signal;
      if (init?.method?.toUpperCase() === 'GET') {
        const abort = new AbortController();
        scope.reconnectAbort = abort;
        signal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      }
      // A server shutting down refuses a new turn before storing it; send it
      // again (to a replica that is ready) before showing an error.
      let response: Response;
      try {
        response = await fetchRetryingDrain((url, options) => fetch(url, options), input, {
          ...init,
          signal,
        });
      } catch (failure) {
        // The connection was lost with no answer: the message may have been
        // stored before it was. Find out from the saved messages, as for a
        // failed answer below (#326). Not for Stop or leaving (an abort).
        if (sending && scope.active && !signal?.aborted && scope.request === request) {
          const sent = readRefusedSubmission(init?.body);
          if (sent) checkSubmission.current(sent);
        }
        throw failure;
      }
      // The SDK cannot abort a reconnect before its headers arrive. Do not let
      // that late response create another browser reader after navigation.
      if (!scope.active || signal?.aborted) {
        await response.body?.cancel();
        throw new DOMException('Conversation changed', 'AbortError');
      }
      const acceptedRun = response.headers.get('X-OCI-Chat-Run-Id');
      if (response.ok && acceptedRun && scope.request === request) {
        scope.runId = acceptedRun;
        setRunId(acceptedRun);
        const submission = sending ? readChatSubmission(init?.body) : null;
        if (submission)
          acceptSubmission.current(submission, response.headers.get('X-OCI-Prompt-Message-Id'));
      }
      // Refused before it was saved (429, 409, 422, 403…): nothing of this
      // message exists on the server, so it must not vanish from the composer.
      // So is a 503 still there after the drain retries (#161): a draining
      // replica answers it before reading the turn, the proxy when no replica
      // is ready, and the chat route itself never does (it answers 500).
      // So is a 500 the server marks as failed before the message could be
      // stored: a database outage longer than its wait (#326).
      const notSaved = response.headers.get(MESSAGE_SAVED_HEADER) === 'no';
      const refusedStatus =
        (response.status >= 400 && response.status < 500) || response.status === 503 || notSaved;
      if (sending && !response.ok && scope.request === request) {
        const sent = readRefusedSubmission(init?.body);
        if (sent && refusedStatus) refuseSubmission.current(sent);
        // Any other failure may have come after the message was stored: find
        // out from the saved messages, once they can be read (#326).
        else if (sent) checkSubmission.current(sent);
      }
      return response;
    },
    [scope],
  );

  const [draft, setDraft] = useState('');
  // Project files left out of the next message only (v0.10); reset on send.
  const [excludedProjectFileIds, setExcludedProjectFileIds] = useState<string[]>([]);
  const [webSearch, setWebSearch] = useState(options.initialWebSearch ?? false);
  // An explicit choice in this conversation: picked here, handed over from the
  // home page or a branch, or the model it last used.
  const [chosenSlug, setChosenSlug] = useState<string | null>(options.initialModelSlug ?? null);
  const attachments = useAttachments();
  const {
    items: attachmentItems,
    consume: consumeAttachments,
    handOver: handOverAttachments,
  } = attachments;

  // Then the person's own default, then the instance default (v0.10). Derived
  // rather than stored, so a default that arrives after the catalog still
  // applies, and a model withdrawn from the catalog falls through silently.
  const personalDefault = currentUser?.chat?.defaultModelSlug;
  const selectedModel = useMemo(
    () => startingModel(models, chosenSlug, personalDefault),
    [models, chosenSlug, personalDefault],
  );
  const modelSlug = selectedModel?.slug ?? null;

  // Starts at the administrator's default; a model switch never retains a
  // level the new model (or this person's role) cannot accept.
  const [effort, setEffort] = useComposerEffort(selectedModel, options.initialEffort);

  // Uploads started on the landing page are carried over on first send.
  const [carriedAttachments, setCarriedAttachments] = useState<Attachment[]>(
    options.carriedAttachments ?? [],
  );
  const consumeFiles = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      consumeAttachments(ids);
      const consumed = new Set(ids);
      setCarriedAttachments((current) => {
        const remaining = current.filter((file) => !consumed.has(file.id));
        return remaining.length === current.length ? current : remaining;
      });
    },
    [consumeAttachments],
  );
  const reconcileFiles = useCallback(
    (messages: UIMessage[]) => {
      consumeFiles(confirmedAttachmentIds(messages));
    },
    [consumeFiles],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        credentials: 'same-origin',
        fetch: fetchChat,
        prepareReconnectToStreamRequest: () => ({
          api: `/api/chat/${encodeURIComponent(options.threadId)}/stream`,
        }),
        prepareSendMessagesRequest: ({ messages, body, trigger }) => {
          // Answering a reply's approvals continues that same reply on the
          // server rather than sending a new message.
          const answered = messages.at(-1);
          const responses = approvalResponsesOf(answered);
          if (answered && responses.length) {
            return {
              api: `/api/chat/${encodeURIComponent(options.threadId)}/approvals`,
              body: { messageId: answered.id, responses, ...browserTimeZone() },
            };
          }
          const latestUser = messages.findLast((message) => message.role === 'user');
          const textParts = latestUser?.parts.flatMap((part) =>
            part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : [],
          );

          return {
            body: {
              ...body,
              messages: latestUser
                ? [{ id: latestUser.id, role: 'user' as const, parts: textParts }]
                : [],
              threadId: options.threadId,
              modelSlug,
              effort: reasoningEffortForRequest(selectedModel, effort),
              webSearch,
              temporary: options.temporary ?? false,
              attachmentIds: trigger === 'regenerate-message' ? [] : (body?.attachmentIds ?? []),
              trigger,
              ...browserTimeZone(),
            },
          };
        },
      }),
    [options.threadId, options.temporary, modelSlug, selectedModel, effort, webSearch, fetchChat],
  );

  const chat = useChat({
    id: options.threadId,
    messages: options.initialMessages,
    transport,
    // Recovery serializes reconnect and canonical hydration to avoid two
    // writers appending a replay to an already-complete saved assistant.
    resume: false,
    // Once every open approval on the latest reply is answered, send them.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ message, isAbort, isDisconnect, isError, finishReason }) => {
      // The server began shutting down while this turn waited for its model,
      // before its reply started (v0.11): send it again, which reaches a
      // server that is running and replaces the empty reply. Twice at most.
      const handedOff = !isAbort && capacityWaitOf(message)?.state === 'handoff';
      if (scope.active && handedOff && handoffRetries.current < HANDOFF_RETRIES) {
        handoffRetries.current++;
        setTimeout(() => sendAgain.current(), 0);
      } else if (!handedOff) handoffRetries.current = 0;
      // Do not reload an entire transcript after every healthy reply. An
      // accepted but interrupted/unfinished stream needs canonical recovery.
      if (scope.active && scope.runId) {
        if (isAbort || isDisconnect || isError || finishReason === undefined)
          requestRecovery.current();
        else clearRun(scope.runId);
      }
      // The reply reorders the sidebar and may have given the conversation a title.
      void invalidateConversationLists(queryClient);
    },
  });

  const { stop: stopChat, sendMessage, setMessages, addToolApprovalResponse } = chat;
  sendAgain.current = () => {
    if (scope.active) void chat.regenerate();
  };
  refuseSubmission.current = ({ clientMessageId, text }) => {
    // Back into the composer (unless something new was typed meanwhile), and
    // the bubble goes: it was never saved, and a reload would drop it anyway.
    setDraft((current) => (current.trim() ? current : text));
    chat.setMessages((current) => current.filter((message) => message.id !== clientMessageId));
    setRefused(true);
  };
  const reconcileSubmission = (saved: UIMessage[]) => {
    const sent = unconfirmed.current;
    unconfirmed.current = null;
    if (!sent || savedAsNew(saved, sent)) return;
    // The reload dropped the unsaved bubble; its text goes back to the
    // composer. The check can take a while with the server unreachable, so
    // anything typed meanwhile is kept after it rather than either being lost.
    setDraft((current) => (current.trim() ? `${sent.text}\n\n${current}` : sent.text));
    setRefused(true);
    setNotice(UNSAVED_MESSAGE_TEXT);
  };
  acceptSubmission.current = (submission, promptId) => {
    consumeFiles(submission.attachmentIds);
    if (promptId && promptId !== submission.clientMessageId)
      chat.setMessages((current) => confirmPromptId(current, submission.clientMessageId, promptId));
  };
  const recovery = useChatRecovery({
    threadId: options.threadId,
    initialMessages: options.initialMessages,
    chat,
    runId,
    clearRun,
    scope,
    onCanonicalMessages: (saved) => {
      reconcileFiles(saved);
      reconcileSubmission(saved);
    },
  });
  requestRecovery.current = recovery.waitForServer;
  // Saved or not, the next canonical reload says (it keeps trying while the
  // server is unreachable). Until then the bubble stays, as sent.
  checkSubmission.current = ({ clientMessageId, text }) => {
    const known = new Set(chat.messages.map((message) => message.id));
    known.delete(clientMessageId);
    unconfirmed.current = { text, known };
    recovery.recover();
  };
  useEffect(() => {
    scope.active = true;
    const lifetime = ++scope.lifetime;
    return () => {
      scope.active = false;
      // Strict Mode immediately reacquires this same scope. Let that happen
      // before aborting a one-shot handover; a real departure stays inactive.
      queueMicrotask(() => {
        if (scope.active || scope.lifetime !== lifetime) return;
        scope.reconnectAbort?.abort();
        void stopChat();
      });
    };
  }, [scope, stopChat]);

  // The stop request still being sent, and whether its last attempt failed (#351).
  const stopRetry = useRef<AbortController | null>(null);
  const [stopDelayed, setStopDelayed] = useState(false);
  const { stopping } = recovery;
  // Nobody wants the request any more once the reply is saved as stopped (or
  // the conversation is left): no more attempts, and no message about them.
  useEffect(() => {
    if (stopping) return;
    stopRetry.current?.abort();
    setStopDelayed(false);
  }, [stopping]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the thread is the trigger, not a value read
  useEffect(() => () => stopRetry.current?.abort(), [options.threadId]);

  const stop = useCallback(async () => {
    // Stopping the browser reader alone must not leave the detached resumable
    // producer running. The owner-scoped endpoint aborts it server-side.
    recovery.waitForStop();
    scope.reconnectAbort?.abort();
    // Pressed again, it asks again at once rather than waiting out a pause.
    stopRetry.current?.abort();
    const request = new AbortController();
    stopRetry.current = request;
    let delayed = false;
    // Not awaited: a server that cannot be reached is asked again for as long
    // as the reply is still running, and the person must not be left waiting
    // on that. A request that failed is not swallowed (#351).
    void requestStop(options.threadId, request.signal, () => {
      delayed = true;
      if (stopRetry.current === request) setStopDelayed(true);
    }).then((outcome) => {
      if (stopRetry.current !== request) return;
      setStopDelayed(false);
      // It got through after a failure: look at the reply again now instead
      // of after the pause the failed checks had grown to.
      if (outcome === 'delivered' && delayed) recovery.recover();
    });
    await stopChat();
  }, [stopChat, options.threadId, recovery.waitForStop, recovery.recover, scope]);

  // Lasts for this conversation only; Settings → Models sets where new ones start.
  const selectModel = useCallback((model: CatalogModel) => setChosenSlug(model.slug), []);

  const send = useCallback(
    async (text?: string) => {
      const content = (text ?? draft).trim();
      if (
        !content ||
        !selectedModel ||
        recovery.remotePending ||
        recovery.resuming ||
        recovery.unavailable
      )
        return;

      // Mirror what the server records so the sent bubble shows its files
      // immediately rather than only after a reload.
      const localAttachments = attachmentItems.flatMap((item) =>
        item.status === 'ready' && item.attachment ? [item.attachment] : [],
      );
      const submitted = [...carriedAttachments, ...localAttachments];
      const cards = submitted.map((attachment) => ({
        type: 'data-attachment' as const,
        data: {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          url: attachment.url,
        },
      }));

      // Being sent: not discarded if the person leaves before it is accepted (#297).
      handOverAttachments(localAttachments.map((file) => file.id));
      setDraft('');
      const excluded = excludedProjectFileIds;
      setExcludedProjectFileIds([]);
      // The server denies unanswered approvals as "not answered" when a new
      // message arrives; show the same without waiting for a reload.
      setMessages(denyUnansweredApprovals);
      await sendMessage(
        {
          parts: [{ type: 'text', text: content }, ...cards],
        } as Parameters<typeof sendMessage>[0],
        {
          body: {
            attachmentIds: submitted.map((file) => file.id),
            ...(excluded.length > 0 && { excludedProjectFileIds: excluded }),
          },
        },
      );
      // The SDK resolves even on HTTP failure. Only accepted response headers
      // (or confirmed canonical history) may consume the submitted files.
    },
    [
      draft,
      excludedProjectFileIds,
      selectedModel,
      attachmentItems,
      handOverAttachments,
      carriedAttachments,
      sendMessage,
      setMessages,
      recovery.remotePending,
      recovery.resuming,
      recovery.unavailable,
    ],
  );

  /** Answers one approval; the reply continues once all of its approvals are answered. */
  const answerApproval = useCallback(
    (approvalId: string, approved: boolean) =>
      addToolApprovalResponse({ id: approvalId, approved }),
    [addToolApprovalResponse],
  );

  return {
    ...chat,
    answerApproval,
    stop,
    /** Stop was pressed and has not reached the server yet; it is being sent again (#351). */
    stopDelayed,
    streaming:
      chat.status === 'streaming' ||
      chat.status === 'submitted' ||
      recovery.remotePending ||
      recovery.resuming,
    recovery,
    /** The last message sent was refused before it was saved (#234). */
    refused,
    /** Why the last message is back in the composer, when no error says so (#326). */
    notice,
    draft,
    setDraft,
    excludedProjectFileIds,
    setExcludedProjectFileIds,
    effort,
    setEffort,
    webSearch,
    setWebSearch,
    models,
    /** The models or the person's features have not arrived yet (#156). */
    optionsLoading: modelsQuery.isPending || !currentUser,
    selectedModel,
    selectModel,
    send,
    attachments,
    features: currentUser?.features,
  };
}

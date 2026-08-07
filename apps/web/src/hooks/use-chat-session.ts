import { useChat } from '@ai-sdk/react';
import type { Attachment, CatalogModel, ReasoningEffort } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState } from 'react';
import { useAttachments } from '~/hooks/use-attachments';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { coerceReasoningEffort, reasoningEffortForRequest } from '~/lib/reasoning';

const MODEL_STORAGE_KEY = 'oci.model';

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
  initialPersonaId?: string | null;
  temporary?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: models = [] } = useModels();
  const { data: currentUser } = useCurrentUser();

  const [draft, setDraft] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>(options.initialEffort ?? 'instant');
  const [webSearch, setWebSearch] = useState(false);
  const [personaId, setPersonaId] = useState<string | null>(options.initialPersonaId ?? null);
  const [modelSlug, setModelSlug] = useState<string | null>(
    () => options.initialModelSlug ?? localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const attachments = useAttachments();

  // Fall back to the catalog default once models load or the saved model
  // disappears from the catalog.
  useEffect(() => {
    if (models.length === 0) return;
    if (modelSlug && models.some((model) => model.slug === modelSlug)) return;

    const fallback = models.find((model) => model.isDefault) ?? models[0];
    if (fallback) setModelSlug(fallback.slug);
  }, [models, modelSlug]);

  const selectedModel = useMemo(
    () => models.find((model) => model.slug === modelSlug) ?? null,
    [models, modelSlug],
  );

  // A model switch must not retain a level the new model cannot accept.
  useEffect(() => {
    if (!selectedModel) return;
    const validEffort = coerceReasoningEffort(selectedModel, effort);
    if (validEffort !== effort) setEffort(validEffort);
  }, [selectedModel, effort]);

  // Uploads started on the landing page are carried over on first send.
  const [carriedAttachments, setCarriedAttachments] = useState<Attachment[]>(
    options.carriedAttachments ?? [],
  );
  const attachmentIds = [
    ...carriedAttachments.map((attachment) => attachment.id),
    ...attachments.readyIds,
  ];
  const attachmentKey = attachmentIds.join(',');

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        credentials: 'same-origin',
        prepareSendMessagesRequest: ({ messages, body, trigger }) => {
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
              personaId,
              temporary: options.temporary ?? false,
              attachmentIds: attachmentKey ? attachmentKey.split(',') : [],
              trigger,
            },
          };
        },
      }),
    [
      options.threadId,
      options.temporary,
      modelSlug,
      selectedModel,
      effort,
      webSearch,
      personaId,
      attachmentKey,
    ],
  );

  const chat = useChat({
    id: options.threadId,
    messages: options.initialMessages,
    transport,
    resume: true,
    onFinish: () => {
      // The server may have renamed the thread from its first message.
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  async function stop() {
    // Stopping the browser reader alone must not leave the detached resumable
    // producer running. The owner-scoped endpoint aborts it server-side.
    const localStop = chat.stop();
    const remoteStop = fetch(`/api/chat/${options.threadId}/stream`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => undefined);
    await Promise.all([localStop, remoteStop]);
  }

  function selectModel(model: CatalogModel) {
    setModelSlug(model.slug);
    setEffort((current) => coerceReasoningEffort(model, current));
    localStorage.setItem(MODEL_STORAGE_KEY, model.slug);
  }

  async function send(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || !selectedModel) return;

    // Mirror what the server records so the sent bubble shows its files
    // immediately rather than only after a reload.
    const localAttachments = attachments.items.flatMap((item) =>
      item.attachment ? [item.attachment] : [],
    );
    const cards = [...carriedAttachments, ...localAttachments].map((attachment) => ({
      type: 'data-attachment' as const,
      data: {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        url: attachment.url,
      },
    }));

    setDraft('');
    await chat.sendMessage({
      parts: [{ type: 'text', text: content }, ...cards],
    } as Parameters<typeof chat.sendMessage>[0]);

    // Attachments belong to the turn that sent them.
    attachments.clear();
    setCarriedAttachments([]);
  }

  return {
    ...chat,
    stop,
    streaming: chat.status === 'streaming' || chat.status === 'submitted',
    draft,
    setDraft,
    effort,
    setEffort,
    webSearch,
    setWebSearch,
    personaId,
    setPersonaId,
    models,
    selectedModel,
    selectModel,
    send,
    attachments,
    features: currentUser?.features,
  };
}

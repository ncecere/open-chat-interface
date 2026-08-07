import { useChat } from '@ai-sdk/react';
import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState } from 'react';
import { useModels } from '~/hooks/use-models';

const MODEL_STORAGE_KEY = 'oci.model';

/**
 * Owns composer state, model selection, and the streaming connection for one
 * thread. Shared by the landing page and the thread view so behaviour cannot
 * drift between them.
 */
export function useChatSession(options: { threadId: string; initialMessages?: UIMessage[] }) {
  const queryClient = useQueryClient();
  const { data: models = [] } = useModels();

  const [draft, setDraft] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('instant');
  const [webSearch, setWebSearch] = useState(false);
  const [modelSlug, setModelSlug] = useState<string | null>(() =>
    localStorage.getItem(MODEL_STORAGE_KEY),
  );

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

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        credentials: 'same-origin',
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: {
            ...body,
            messages,
            threadId: options.threadId,
            modelSlug,
            effort: effort === 'instant' ? undefined : effort,
            webSearch,
          },
        }),
      }),
    [options.threadId, modelSlug, effort, webSearch],
  );

  const chat = useChat({
    id: options.threadId,
    messages: options.initialMessages,
    transport,
    onFinish: () => {
      // The server may have renamed the thread from its first message.
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });

  function selectModel(model: CatalogModel) {
    setModelSlug(model.slug);
    localStorage.setItem(MODEL_STORAGE_KEY, model.slug);
  }

  async function send(text?: string) {
    const content = (text ?? draft).trim();
    if (!content || !selectedModel) return;
    setDraft('');
    await chat.sendMessage({ text: content });
  }

  return {
    ...chat,
    streaming: chat.status === 'streaming' || chat.status === 'submitted',
    draft,
    setDraft,
    effort,
    setEffort,
    webSearch,
    setWebSearch,
    models,
    selectedModel,
    selectModel,
    send,
  };
}

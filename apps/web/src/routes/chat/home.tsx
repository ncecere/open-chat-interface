import type { CatalogModel } from '@oci/shared';
import { useNavigate } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { DEFAULT_PROMPTS, SUGGESTION_CATEGORIES } from '~/components/chat/suggestions';
import { ProjectChatNotice } from '~/components/projects/project-chat-notice';
import { useAttachments } from '~/hooks/use-attachments';
import { useComposerEffort } from '~/hooks/use-composer-effort';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { useCreateThread } from '~/hooks/use-threads';
import { reasoningEffortForRequest } from '~/lib/reasoning';
import { cn } from '~/lib/utils';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

type CategoryId = (typeof SUGGESTION_CATEGORIES)[number]['id'];

const MODEL_STORAGE_KEY = 'oci.model';
const EMPTY_MODELS: CatalogModel[] = [];
const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_THREAD_KEY = 'oci.pendingThreadId';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';

/**
 * Landing page. Sending here creates a thread first, then hands the prompt to
 * the thread view so the streaming connection belongs to a real thread ID.
 *
 * With `projectId` (from "New chat in project"), the new conversation is
 * created inside that project. A project chat is never temporary.
 */
export function ChatHomePage({ projectId }: { projectId?: string } = {}) {
  const { data } = useCurrentUser();
  const { data: models = EMPTY_MODELS } = useModels();
  const navigate = useNavigate();
  const { mutateAsync: createThread } = useCreateThread();
  const { temporary: temporaryMode } = useTemporaryChat();
  const temporary = temporaryMode && !projectId;

  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [draft, setDraft] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [modelSlug, setModelSlug] = useState<string | null>(() =>
    localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const { items: attachmentItems, upload, remove } = useAttachments();

  const selectedModel =
    models.find((model) => model.slug === modelSlug) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null;
  // The administrator's default, clamped to what this model and role allow.
  const [effort, setEffort] = useComposerEffort(selectedModel);

  const firstName = data?.user.name.split(' ')[0];
  const prompts =
    SUGGESTION_CATEGORIES.find((category) => category.id === activeCategory)?.prompts ??
    DEFAULT_PROMPTS;

  const selectModel = useCallback((model: CatalogModel) => {
    setModelSlug(model.slug);
    localStorage.setItem(MODEL_STORAGE_KEY, model.slug);
  }, []);

  const startThread = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !selectedModel) return;

      const { thread } = await createThread(
        projectId ? { temporary: false, projectId } : { temporary },
      );
      // Invalidate the old destination before changing any payload fields.
      sessionStorage.removeItem(PENDING_THREAD_KEY);
      sessionStorage.setItem(PENDING_KEY, content);
      const requestEffort = reasoningEffortForRequest(selectedModel, effort);
      if (requestEffort) sessionStorage.setItem(PENDING_EFFORT_KEY, requestEffort);
      else sessionStorage.removeItem(PENDING_EFFORT_KEY);
      if (webSearch) sessionStorage.setItem(PENDING_SEARCH_KEY, 'true');
      else sessionStorage.removeItem(PENDING_SEARCH_KEY);

      // Hand any uploads over to the thread view along with the prompt.
      const readyAttachments = attachmentItems.flatMap((item) =>
        item.attachment ? [item.attachment] : [],
      );
      if (readyAttachments.length > 0) {
        // Carry display metadata as well as IDs so the first sent bubble can
        // render its attachment cards immediately.
        sessionStorage.setItem(PENDING_ATTACHMENTS_KEY, JSON.stringify(readyAttachments));
      } else {
        sessionStorage.removeItem(PENDING_ATTACHMENTS_KEY);
      }

      sessionStorage.setItem(PENDING_THREAD_KEY, thread.id);
      await navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
    },
    [
      selectedModel,
      createThread,
      temporary,
      projectId,
      effort,
      webSearch,
      attachmentItems,
      navigate,
    ],
  );

  const submit = useCallback(() => startThread(draft), [startThread, draft]);

  return (
    <div className="flex h-full flex-col justify-center md:justify-normal">
      {/* Desktop uses the upper-middle region; mobile centers the compact prompt. */}
      <div className="flex-none px-4 md:flex-1 md:overflow-y-auto md:pt-[18vh]">
        <div className="mx-auto w-full max-w-[41.75rem]">
          <h1 className="block items-center gap-3 text-center text-[1.375rem] font-bold leading-tight tracking-tight md:flex md:text-left md:text-[1.875rem]">
            {temporary && <Clock className="size-7 text-[var(--accent-bright)]" />}
            {temporary ? (
              'Temporary chat'
            ) : (
              <>
                How can I help you{firstName ? ',' : '?'}
                {firstName && (
                  <>
                    <span className="block md:hidden">{firstName}?</span>
                    <span className="hidden md:inline"> {firstName}?</span>
                  </>
                )}
              </>
            )}
          </h1>
          {temporary && (
            <p className="mt-2 text-center text-sm text-[var(--text-muted)] md:text-left">
              This conversation stays out of history and expires automatically after 24 hours.
            </p>
          )}
          {projectId && <ProjectChatNotice projectId={projectId} />}

          <div className="mt-7 hidden flex-wrap gap-2.5 md:flex">
            {SUGGESTION_CATEGORIES.map((category) => {
              const active = activeCategory === category.id;
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setActiveCategory(active ? null : category.id)}
                  className={cn(
                    'inline-flex h-[2.375rem] items-center gap-2 rounded-xl px-5 text-sm font-medium transition-colors',
                    '[&_svg]:size-4 [&_svg]:shrink-0',
                    active
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'bg-[var(--bg-control-alt)] text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <category.icon />
                  {category.label}
                </button>
              );
            })}
          </div>

          <div className="mt-9 hidden md:block">
            {prompts.map((prompt, index) => (
              <button
                key={prompt}
                type="button"
                onClick={() => startThread(prompt)}
                className={cn(
                  'block h-[3.0625rem] w-full pr-8 text-left text-[0.9375rem] text-[var(--text-secondary)]',
                  'transition-colors hover:text-[var(--text-primary)]',
                  index < prompts.length - 1 && 'border-b border-[var(--border-subtle)]/45',
                )}
              >
                {prompt}
              </button>
            ))}
          </div>

          {models.length === 0 && (
            <p className="mt-8 rounded-xl bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--warning)]">
              No models are available yet. An administrator needs to add a provider and enable a
              model in the catalog.
            </p>
          )}
        </div>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={selectModel}
        effort={effort}
        onEffortChange={setEffort}
        webSearch={webSearch}
        onWebSearchChange={setWebSearch}
        webSearchAvailable={data?.features.webSearch ?? false}
        attachmentsAvailable={data?.features.attachments ?? false}
        attachments={attachmentItems}
        onAttachFiles={upload}
        onRemoveAttachment={remove}
      />
    </div>
  );
}

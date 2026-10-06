import type { CatalogModel } from '@oci/shared';
import { useNavigate } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { DEFAULT_PROMPTS, SUGGESTION_CATEGORIES } from '~/components/chat/suggestions';
import { ProjectChatNotice } from '~/components/projects/project-chat-notice';
import { useAttachments } from '~/hooks/use-attachments';
import { useComposerEffort } from '~/hooks/use-composer-effort';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { useCreateThread } from '~/hooks/use-threads';
import { apiErrorMessage } from '~/lib/api-client';
import { focusComposerOnArrival } from '~/lib/focus-after-navigation';
import { reasoningEffortForRequest } from '~/lib/reasoning';
import { forgetBrowserModel, startingModel } from '~/lib/starting-model';
import { clearRestoredDraft, peekRestoredDraft } from '~/lib/unused-conversation';
import { cn } from '~/lib/utils';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

type CategoryId = (typeof SUGGESTION_CATEGORIES)[number]['id'];

const EMPTY_MODELS: CatalogModel[] = [];
const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_THREAD_KEY = 'oci.pendingThreadId';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
/** The model chosen here, handed to the new conversation (v0.10; was `oci.model`). */
const PENDING_MODEL_KEY = 'oci.pendingModel';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';
/** Set when the person was typing in the composer, so the conversation keeps focus there. */
const PENDING_FOCUS_KEY = 'oci.pendingComposerFocus';

/**
 * Landing page. Sending here creates a thread first, then hands the prompt to
 * the thread view so the streaming connection belongs to a real thread ID.
 *
 * With `projectId` (from "New chat in project"), the new conversation is
 * created inside that project. A project chat is never temporary.
 */
export function ChatHomePage({ projectId }: { projectId?: string } = {}) {
  const { data } = useCurrentUser();
  const modelsQuery = useModels();
  const models = modelsQuery.data ?? EMPTY_MODELS;
  // Until the models and the person's features arrive, nothing is said about
  // them: "No models are available yet" was shown for as long as the request
  // took, and the greeting and Attach appeared later, moving the page (#156).
  const loading = modelsQuery.isPending || !data;
  const navigate = useNavigate();
  const { mutateAsync: createThread } = useCreateThread();
  const { temporary: temporaryMode, setTemporary } = useTemporaryChat();
  const temporary = temporaryMode && !projectId;
  // A project chat is never temporary, so the mode is switched off here
  // rather than left highlighted in the top bar over a chat that will be kept.
  useEffect(() => {
    if (projectId && temporaryMode) setTemporary(false);
  }, [projectId, temporaryMode, setTemporary]);

  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  // The unsent text of a conversation this tab removed as it reloaded (#266).
  const [draft, setDraftValue] = useState(peekRestoredDraft);
  useEffect(() => clearRestoredDraft(), []);
  /**
   * One conversation per send (v0.10.2). `started` is set synchronously before
   * the first await, so a key that repeats, an automated browser flooding
   * Enter, or a second click cannot start another conversation while the
   * first is being created; in v0.10.1 each one was another empty "New Chat".
   * It stays set once the prompt is handed over, because this page can still
   * be on screen before the conversation renders. A failure releases it, and
   * so does editing the draft once nothing is outstanding.
   */
  const started = useRef(false);
  const creating = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const setDraft = useCallback((value: string) => {
    setDraftValue(value);
    if (started.current && !creating.current) {
      started.current = false;
      setSubmitting(false);
    }
  }, []);
  const [webSearch, setWebSearch] = useState(false);
  // A model picked here applies to the conversation it starts; otherwise the
  // person's own default (Settings → Models), then the instance default.
  const [modelSlug, setModelSlug] = useState<string | null>(null);
  const { items: attachmentItems, upload, remove, handOver: handOverUploads } = useAttachments();
  useEffect(() => forgetBrowserModel(), []);
  // A new chat is there to be typed in: the cursor starts in the box, however
  // the person arrived (#251). Not on a touch-only device (see touchOnly).
  useEffect(() => focusComposerOnArrival(), []);

  const selectedModel = startingModel(models, modelSlug, data?.chat?.defaultModelSlug);
  // The person's default level, else the administrator's, clamped to what this
  // model and role allow.
  const [effort, setEffort] = useComposerEffort(selectedModel);

  const firstName = data?.user.name.split(' ')[0];
  const prompts =
    SUGGESTION_CATEGORIES.find((category) => category.id === activeCategory)?.prompts ??
    DEFAULT_PROMPTS;

  const selectModel = useCallback((model: CatalogModel) => setModelSlug(model.slug), []);

  const handOver = useCallback(
    async (content: string, selectedModel: CatalogModel) => {
      // Read before any await: the composer is replaced when the conversation opens.
      const typing =
        document.activeElement instanceof HTMLTextAreaElement &&
        document.activeElement.getAttribute('aria-label') === 'Message input';

      const { thread } = await createThread(
        projectId ? { temporary: false, projectId } : { temporary },
      );
      // Invalidate the old destination before changing any payload fields.
      sessionStorage.removeItem(PENDING_THREAD_KEY);
      sessionStorage.setItem(PENDING_KEY, content);
      sessionStorage.setItem(PENDING_MODEL_KEY, selectedModel.slug);
      const requestEffort = reasoningEffortForRequest(selectedModel, effort);
      if (requestEffort) sessionStorage.setItem(PENDING_EFFORT_KEY, requestEffort);
      else sessionStorage.removeItem(PENDING_EFFORT_KEY);
      if (webSearch) sessionStorage.setItem(PENDING_SEARCH_KEY, 'true');
      else sessionStorage.removeItem(PENDING_SEARCH_KEY);
      if (typing) sessionStorage.setItem(PENDING_FOCUS_KEY, 'true');
      else sessionStorage.removeItem(PENDING_FOCUS_KEY);

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
      // The conversation sends them: this page must not discard them as it goes (#297).
      handOverUploads(readyAttachments.map((file) => file.id));
      await navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
    },
    [
      createThread,
      temporary,
      projectId,
      effort,
      webSearch,
      attachmentItems,
      handOverUploads,
      navigate,
    ],
  );

  const startThread = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || !selectedModel || started.current) return;
      started.current = true;
      creating.current = true;
      setSubmitting(true);
      setStartError(null);
      try {
        await handOver(content, selectedModel);
      } catch (error) {
        started.current = false;
        setSubmitting(false);
        // Such as the server's limit on starting conversations (429).
        setStartError(apiErrorMessage(error, 'The conversation could not be started. Try again.'));
        throw error;
      } finally {
        creating.current = false;
      }
    },
    [selectedModel, handOver],
  );

  const submit = useCallback(() => startThread(draft), [startThread, draft]);

  return (
    <div className="flex h-full flex-col justify-center md:justify-normal">
      {/* Desktop uses the upper-middle region; mobile centers the compact prompt. */}
      {/* On phones, room between the greeting and the centred composer (#102). */}
      <div className="flex-none px-4 pb-8 md:flex-1 md:overflow-y-auto md:pt-[11vh] md:pb-0">
        <div className="mx-auto w-full max-w-[41.75rem]">
          <h1 className="block items-center gap-3 text-center text-[1.375rem] font-bold leading-tight tracking-tight md:flex md:text-left md:text-[1.875rem]">
            {temporary && <Clock className="size-7 text-[var(--accent-bright)]" />}
            {temporary ? (
              'Temporary chat'
            ) : (
              // One text item, so the flex gap (for the icon) never lands after
              // the comma, and the name is in the DOM once, not once per
              // breakpoint (#94). On phones the name wraps to its own line.
              // Hidden, with room for the name, until it is known.
              <span className={cn(!data && 'invisible')}>
                How can I help you{firstName || !data ? ', ' : '?'}
                {(firstName || !data) && (
                  <span className="block md:inline">{firstName ?? '\u00a0'}?</span>
                )}
              </span>
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
                disabled={submitting}
                onClick={() => {
                  // Failures leave the page as it was, ready to try again.
                  startThread(prompt).catch(() => undefined);
                }}
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

          {modelsQuery.isSuccess && models.length === 0 && (
            <p className="mt-8 rounded-xl bg-[var(--warning)]/10 px-4 py-3 text-sm text-[var(--warning)]">
              No models are available yet. An administrator needs to add a provider and enable a
              model in the catalog.
            </p>
          )}
          {modelsQuery.isError && (
            <p
              role="alert"
              className="mt-8 rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
            >
              The list of models could not be loaded. Reload the page to try again.
            </p>
          )}
          {startError && (
            <p
              role="alert"
              className="mt-8 rounded-xl bg-[var(--danger)]/15 px-4 py-3 text-sm text-[var(--danger-on-tint)]"
            >
              {startError}
            </p>
          )}
        </div>
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        submitting={submitting}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={selectModel}
        effort={effort}
        onEffortChange={setEffort}
        webSearch={webSearch}
        onWebSearchChange={setWebSearch}
        webSearchAvailable={data?.features.webSearch ?? false}
        // Shown (waiting) until known, so it does not appear later and move the row.
        attachmentsAvailable={data ? data.features.attachments : true}
        loading={loading}
        attachments={attachmentItems}
        onAttachFiles={upload}
        onRemoveAttachment={remove}
      />
    </div>
  );
}

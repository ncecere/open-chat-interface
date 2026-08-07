import type { ReasoningEffort } from '@oci/shared';
import { useNavigate } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import { useState } from 'react';
import { Composer } from '~/components/chat/composer';
import { DEFAULT_PROMPTS, SUGGESTION_CATEGORIES } from '~/components/chat/suggestions';
import { useAttachments } from '~/hooks/use-attachments';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { useCreateThread } from '~/hooks/use-threads';
import { coerceReasoningEffort, reasoningEffortForRequest } from '~/lib/reasoning';
import { cn } from '~/lib/utils';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

type CategoryId = (typeof SUGGESTION_CATEGORIES)[number]['id'];

const MODEL_STORAGE_KEY = 'oci.model';
const PENDING_KEY = 'oci.pendingPrompt';
const PENDING_ATTACHMENTS_KEY = 'oci.pendingAttachments';
const PENDING_EFFORT_KEY = 'oci.pendingEffort';
const PENDING_SEARCH_KEY = 'oci.pendingWebSearch';

/**
 * Landing page. Sending here creates a thread first, then hands the prompt to
 * the thread view so the streaming connection belongs to a real thread ID.
 */
export function ChatHomePage() {
  const { data } = useCurrentUser();
  const { data: models = [] } = useModels();
  const navigate = useNavigate();
  const createThread = useCreateThread();
  const { temporary } = useTemporaryChat();

  const [activeCategory, setActiveCategory] = useState<CategoryId | null>(null);
  const [draft, setDraft] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort>('instant');
  const [webSearch, setWebSearch] = useState(false);
  const [modelSlug, setModelSlug] = useState<string | null>(() =>
    localStorage.getItem(MODEL_STORAGE_KEY),
  );
  const attachments = useAttachments();

  const selectedModel =
    models.find((model) => model.slug === modelSlug) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null;

  const firstName = data?.user.name.split(' ')[0];
  const prompts =
    SUGGESTION_CATEGORIES.find((category) => category.id === activeCategory)?.prompts ??
    DEFAULT_PROMPTS;

  async function startThread(text: string) {
    const content = text.trim();
    if (!content || !selectedModel) return;

    const { thread } = await createThread.mutateAsync({ temporary });
    sessionStorage.setItem(PENDING_KEY, content);
    const requestEffort = reasoningEffortForRequest(selectedModel, effort);
    if (requestEffort) sessionStorage.setItem(PENDING_EFFORT_KEY, requestEffort);
    else sessionStorage.removeItem(PENDING_EFFORT_KEY);
    if (webSearch) sessionStorage.setItem(PENDING_SEARCH_KEY, 'true');
    else sessionStorage.removeItem(PENDING_SEARCH_KEY);

    // Hand any uploads over to the thread view along with the prompt.
    const readyAttachments = attachments.items.flatMap((item) =>
      item.attachment ? [item.attachment] : [],
    );
    if (readyAttachments.length > 0) {
      // Carry display metadata as well as IDs so the first sent bubble can
      // render its attachment cards immediately.
      sessionStorage.setItem(PENDING_ATTACHMENTS_KEY, JSON.stringify(readyAttachments));
    } else {
      sessionStorage.removeItem(PENDING_ATTACHMENTS_KEY);
    }

    await navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
  }

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
        onSubmit={() => startThread(draft)}
        models={models}
        selectedModel={selectedModel}
        onSelectModel={(model) => {
          setModelSlug(model.slug);
          setEffort((current) => coerceReasoningEffort(model, current));
          localStorage.setItem(MODEL_STORAGE_KEY, model.slug);
        }}
        effort={effort}
        onEffortChange={setEffort}
        webSearch={webSearch}
        onWebSearchChange={setWebSearch}
        webSearchAvailable={data?.features.webSearch ?? false}
        attachmentsAvailable={data?.features.attachments ?? false}
        attachments={attachments.items}
        onAttachFiles={attachments.upload}
        onRemoveAttachment={attachments.remove}
      />
    </div>
  );
}

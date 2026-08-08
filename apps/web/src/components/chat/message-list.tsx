import type { UIMessage } from 'ai';
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  FileText,
  GitFork,
  Globe2,
  Info,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import {
  SearchGroundingDetails,
  SearchLoading,
  SearchSourcesPanel,
  searchGroundingOf,
} from '~/components/chat/search-grounding';
import { Button } from '~/components/ui/button';
import { useModels } from '~/hooks/use-models';
import { cn } from '~/lib/utils';

/** The responding model and effort, sent as stream metadata and persisted per message. */
function metadataOf(message: UIMessage): {
  modelSlug: string | null;
  effort: string | null;
  status: string | null;
} {
  const metadata = message.metadata as
    | { modelSlug?: unknown; effort?: unknown; status?: unknown }
    | undefined;
  return {
    modelSlug: typeof metadata?.modelSlug === 'string' ? metadata.modelSlug : null,
    effort: typeof metadata?.effort === 'string' ? metadata.effort : null,
    status: typeof metadata?.status === 'string' ? metadata.status : null,
  };
}

function ModelAttribution({ slug, effort }: { slug: string | null; effort: string | null }) {
  const { data: models } = useModels();
  if (!slug) return null;
  const model = models?.find((entry) => entry.slug === slug);

  return (
    <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-[var(--text-muted)]">
      <span className="max-w-52 truncate">{model?.displayName ?? slug}</span>
      {effort && <span className="capitalize">({effort})</span>}
    </span>
  );
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

interface AttachmentCard {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
}

/** Attachment metadata the server records alongside a sent user turn. */
function attachmentsOf(message: UIMessage): AttachmentCard[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'data-attachment') return [];
    const data = (part as { data?: Partial<AttachmentCard> }).data;
    return data?.id && data.filename && data.mimeType && data.url ? [data as AttachmentCard] : [];
  });
}

function AttachmentCards({ cards }: { cards: AttachmentCard[] }) {
  if (cards.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {cards.map((card) =>
        card.mimeType.startsWith('image/') ? (
          <a key={card.id} href={card.url} target="_blank" rel="noreferrer" title={card.filename}>
            <img
              src={card.url}
              alt={card.filename}
              className="size-14 rounded-lg border border-[var(--border-strong)] object-cover"
            />
          </a>
        ) : (
          <a
            key={card.id}
            href={card.url}
            target="_blank"
            rel="noreferrer"
            title={card.filename}
            className="flex items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control-alt)] px-3 py-2.5 transition-colors hover:bg-[var(--bg-control-hover)]"
          >
            <FileText className="size-4 shrink-0 text-[var(--text-muted)]" />
            <span className="max-w-52 truncate text-sm text-[var(--text-secondary)]">
              {card.filename}
            </span>
          </a>
        ),
      )}
    </div>
  );
}

function reasoningOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'reasoning'; text: string } => part.type === 'reasoning')
    .map((part) => part.text)
    .join('\n');
}

function ReasoningPanel({
  text,
  streaming,
  answerStarted,
}: {
  text: string;
  streaming: boolean;
  answerStarted: boolean;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);

  /**
   * Expanded while reasoning is the only thing happening, so the wait shows
   * something rather than hiding it behind a disclosure. It collapses once the
   * answer starts, which is what the reader actually wants. An explicit click
   * wins either way.
   */
  const open = choice ?? (streaming && !answerStarted);

  return (
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="flex w-fit items-center gap-2 text-left text-[0.8125rem] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Brain className={cn('size-4 shrink-0', streaming && 'animate-pulse')} />
        <span>{streaming ? 'Thinking...' : 'Reasoning'}</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <>
          <div className="mt-4 rounded-lg bg-black/15 px-3 py-3 text-[0.9375rem] leading-7 text-[var(--text-secondary)]">
            <Markdown
              className={cn(
                'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
                '[&_strong]:text-[var(--text-primary)]',
                '[&_code]:rounded [&_code]:bg-black/20 [&_code]:px-1 [&_code]:py-0.5',
                '[&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
                '[&_li::marker]:text-[var(--accent-bright)]',
              )}
            >
              {text}
            </Markdown>
          </div>
          <p className="mt-2 flex items-start gap-2 px-1 text-[0.6875rem] leading-4 text-[var(--text-muted)]">
            <Info className="mt-0.5 size-3 shrink-0" />
            <span>
              Some models hide parts of their thinking, so you may see a summary or partial
              reasoning here.
            </span>
          </p>
        </>
      )}
    </div>
  );
}

function MessageActions({
  text,
  onRetry,
  onEdit,
  onFork,
  modelSlug,
  effort,
  searched,
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
  onFork?: () => Promise<void>;
  modelSlug?: string | null;
  effort?: string | null;
  searched?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex min-h-8 flex-wrap items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy message"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
      </Button>

      {onFork && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Fork conversation here"
          onClick={() => void onFork()}
        >
          <GitFork />
        </Button>
      )}

      {onEdit && (
        <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={onEdit}>
          <Pencil />
        </Button>
      )}

      {onRetry && (
        <Button variant="ghost" size="icon-sm" aria-label="Retry" onClick={onRetry}>
          <RefreshCw />
        </Button>
      )}

      <ModelAttribution slug={modelSlug ?? null} effort={effort ?? null} />
      {searched && (
        <Globe2 className="ml-0.5 size-3.5 text-[var(--text-muted)]" aria-label="Web search used" />
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  onRetry,
  onEdit,
  onFork,
  searching = false,
}: {
  messages: UIMessage[];
  streaming: boolean;
  onRetry: () => void;
  searching?: boolean;
  onEdit?: (messageId: string, text: string) => Promise<void>;
  onFork?: (messageId: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const last = messages.at(-1);
  const lastIsAssistant = last?.role === 'assistant';
  const lastText = lastIsAssistant ? textOf(last) : '';
  const lastReasoning = lastIsAssistant ? reasoningOf(last) : '';

  // An assistant row exists well before it has anything to show, so presence
  // of the row cannot stand in for progress.
  const hasVisibleContent = Boolean(lastText || lastReasoning);

  // Announced to assistive technology only. The animation carries the meaning
  // visually, so repeating it as text beside the dots would just be noise.
  const waitingLabel = lastReasoning ? 'Thinking' : 'Generating response';

  function cancelEdit() {
    if (saving) return;
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit(messageId: string) {
    const text = editText.trim();
    if (!text || !onEdit || saving) return;

    setSaving(true);
    setEditError(null);
    try {
      await onEdit(messageId, text);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not branch this message.');
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 px-4 py-8">
      {messages.map((message, index) => {
        const text = textOf(message);
        const reasoning = reasoningOf(message);
        const grounding = searchGroundingOf(message);
        const metadata = metadataOf(message);
        const isLast = index === messages.length - 1;

        if (message.role === 'user') {
          const editing = editingId === message.id;

          return (
            <article
              key={message.id}
              className="group flex flex-col items-end"
              aria-label="Your message"
            >
              {editing ? (
                <div className="w-full max-w-[85%] rounded-2xl border border-[var(--accent)]/60 bg-[var(--bg-user-message)] p-3">
                  <textarea
                    aria-label="Edit message text"
                    value={editText}
                    disabled={saving}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') cancelEdit();
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault();
                        void saveEdit(message.id);
                      }
                    }}
                    className="min-h-24 w-full resize-y bg-transparent px-1 text-[0.9375rem] leading-relaxed text-[var(--text-primary)] outline-none disabled:opacity-60"
                  />
                  {editError && (
                    <p className="px-1 pb-2 text-xs text-[var(--danger-foreground)]">{editError}</p>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={saving} onClick={cancelEdit}>
                      <X />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={saving || !editText.trim()}
                      onClick={() => void saveEdit(message.id)}
                    >
                      {saving ? 'Branching...' : 'Save & submit'}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="max-w-[85%] rounded-2xl border border-[var(--border-user-message)] bg-[var(--bg-user-message)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)]">
                    <Markdown>{text}</Markdown>
                    <AttachmentCards cards={attachmentsOf(message)} />
                  </div>
                  <MessageActions
                    text={text}
                    onFork={onFork && !streaming ? () => onFork(message.id) : undefined}
                    onEdit={
                      onEdit && !streaming
                        ? () => {
                            setEditingId(message.id);
                            setEditText(text);
                            setEditError(null);
                          }
                        : undefined
                    }
                  />
                </>
              )}
            </article>
          );
        }

        return (
          <article key={message.id} className="group flex flex-col" aria-label="Assistant message">
            {grounding && <SearchSourcesPanel grounding={grounding} />}
            {reasoning && (
              <ReasoningPanel
                text={reasoning}
                streaming={streaming && isLast}
                answerStarted={Boolean(text)}
              />
            )}

            <div className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              <Markdown className={MARKDOWN_PROSE}>{text}</Markdown>
            </div>

            {grounding && <SearchGroundingDetails grounding={grounding} />}

            {!(streaming && isLast) && (
              <MessageActions
                text={text}
                onFork={
                  onFork && metadata.status !== 'streaming' ? () => onFork(message.id) : undefined
                }
                onRetry={isLast ? onRetry : undefined}
                modelSlug={metadata.modelSlug}
                effort={metadata.effort}
                searched={Boolean(grounding)}
              />
            )}
          </article>
        );
      })}

      {/*
       * Shown from submission until the first visible content arrives, which
       * is not the same as "until the assistant message exists": that row is
       * created empty and can sit silent for seconds while a model reasons.
       * Keying off content rather than message role is what makes the wait
       * legible on every provider, including those that never reveal any
       * reasoning at all.
       */}
      {streaming &&
        !hasVisibleContent &&
        (searching ? (
          <SearchLoading />
        ) : (
          <div role="status" className="flex gap-1.5 py-2" aria-label={waitingLabel}>
            {[0, 1, 2].map((dot) => (
              <span
                key={dot}
                className="size-1.5 animate-bounce rounded-full bg-[var(--text-muted)]"
                style={{ animationDelay: `${dot * 0.15}s` }}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

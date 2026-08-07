import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import type { UIMessage } from 'ai';
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  Globe2,
  Info,
  Pencil,
  RefreshCw,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Streamdown } from 'streamdown';
import { LabLogo } from '~/components/model/lab-logo';
import { Button } from '~/components/ui/button';
import { useModels } from '~/hooks/use-models';
import { cn } from '~/lib/utils';

/**
 * Syntax highlighting and KaTeX are opt-in Streamdown plugins. Single-dollar
 * inline math is off by default, but models commonly emit it.
 */
const PLUGINS = { code, math: createMathPlugin({ singleDollarTextMath: true }) };

/** The responding model, sent as stream metadata and persisted per message. */
function modelSlugOf(message: UIMessage): string | null {
  const metadata = message.metadata as { modelSlug?: unknown } | undefined;
  return typeof metadata?.modelSlug === 'string' ? metadata.modelSlug : null;
}

/**
 * Attributes a reply to the model that produced it. Threads can switch models
 * partway through, so without this every response looks identical.
 */
function ModelAttribution({ slug }: { slug: string | null }) {
  const { data: models } = useModels();
  if (!slug) return null;

  const model = models?.find((entry) => entry.slug === slug);

  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[0.6875rem] text-[var(--text-muted)]">
      <LabLogo labId={model?.labId} className="size-3.5" />
      <span className="truncate">{model?.displayName ?? slug}</span>
    </div>
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

interface MessageSource {
  sourceId: string;
  url: string;
  title?: string;
}

function sourcesOf(message: UIMessage): MessageSource[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'source-url') return [];
    const source = part as Partial<MessageSource>;
    return source.sourceId && source.url ? [source as MessageSource] : [];
  });
}

function SearchSourcesPanel({ sources }: { sources: MessageSource[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-2 text-[0.8125rem] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Globe2 className="size-4" />
        <span>Searched the web</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="mt-3 grid gap-2 rounded-lg bg-black/15 p-3 sm:grid-cols-2">
          {sources.map((source) => {
            let hostname = source.url;
            try {
              hostname = new URL(source.url).hostname.replace(/^www\./, '');
            } catch {
              // The API already validates source URLs; retain the URL as fallback.
            }

            return (
              <a
                key={source.sourceId}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="group min-w-0 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/45 p-3 transition-colors hover:bg-[var(--bg-control-hover)]"
              >
                <span className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                      {source.title || hostname}
                    </span>
                    <span className="mt-1 block truncate text-[0.6875rem] text-[var(--text-muted)]">
                      {hostname}
                    </span>
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]" />
                </span>
              </a>
            );
          })}
        </div>
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

function ReasoningPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
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
            <Streamdown
              plugins={PLUGINS}
              className={cn(
                'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
                '[&_strong]:text-[var(--text-primary)]',
                '[&_code]:rounded [&_code]:bg-black/20 [&_code]:px-1 [&_code]:py-0.5',
                '[&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
                '[&_li::marker]:text-[var(--accent-bright)]',
              )}
            >
              {text}
            </Streamdown>
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
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  onRetry,
  onEdit,
}: {
  messages: UIMessage[];
  streaming: boolean;
  onRetry: () => void;
  onEdit?: (messageId: string, text: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
    <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 px-4 py-8">
      {messages.map((message, index) => {
        const text = textOf(message);
        const reasoning = reasoningOf(message);
        const sources = sourcesOf(message);
        const isLast = index === messages.length - 1;

        if (message.role === 'user') {
          const editing = editingId === message.id;

          return (
            <div key={message.id} className="group flex flex-col items-end">
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
                    <Streamdown plugins={PLUGINS}>{text}</Streamdown>
                    <AttachmentCards cards={attachmentsOf(message)} />
                  </div>
                  <MessageActions
                    text={text}
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
            </div>
          );
        }

        return (
          <div key={message.id} className="group flex flex-col">
            <ModelAttribution slug={modelSlugOf(message)} />
            {sources.length > 0 && <SearchSourcesPanel sources={sources} />}
            {reasoning && <ReasoningPanel text={reasoning} streaming={streaming && isLast} />}

            <div className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
              <Streamdown
                plugins={PLUGINS}
                className={cn(
                  'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
                  '[&_a]:text-[var(--accent-bright)] [&_a]:underline-offset-2',
                  '[&_strong]:text-[var(--text-primary)]',
                  '[&_code]:rounded [&_code]:bg-[var(--bg-control)] [&_code]:px-1 [&_code]:py-0.5',
                  '[&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
                  '[&_hr]:border-[var(--border-subtle)]',
                  '[&_li::marker]:text-[var(--accent-bright)]',
                )}
              >
                {text}
              </Streamdown>
            </div>

            {!(streaming && isLast) && (
              <MessageActions text={text} onRetry={isLast ? onRetry : undefined} />
            )}
          </div>
        );
      })}

      {streaming && messages.at(-1)?.role === 'user' && (
        <div className="flex gap-1.5 py-2">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 animate-bounce rounded-full bg-[var(--text-muted)]"
              style={{ animationDelay: `${dot * 0.15}s` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

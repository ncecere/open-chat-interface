import type { SearchGroundingData } from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, Globe2, Link2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { SafeExternalLink } from '~/components/chat/external-link-warning';
import { cn } from '~/lib/utils';

interface MessageSource {
  sourceId: string;
  url: string;
  title?: string;
}

export interface SearchGroundingView {
  query: string | null;
  results: SearchGroundingData['results'];
  /** Why the search failed; the reply went ahead without results. */
  error?: string;
  /** Which provider answered (v0.10), and whether it was the fallback. */
  provider?: string;
  fallback?: boolean;
}

function sourcePartsOf(message: UIMessage): MessageSource[] {
  return message.parts.flatMap((part) => {
    if (part.type !== 'source-url') return [];
    const source = part as Partial<MessageSource>;
    return source.sourceId && source.url ? [source as MessageSource] : [];
  });
}

/** Reads persisted custom data first, with source-url parts as a legacy fallback. */
export function searchGroundingOf(message: UIMessage): SearchGroundingView | null {
  const details = message.parts.find((part) => part.type === 'data-search-grounding') as
    | { data?: Partial<SearchGroundingData> }
    | undefined;
  if (details?.data?.query && Array.isArray(details.data.results)) {
    return {
      query: details.data.query,
      results: details.data.results.filter(
        (result): result is SearchGroundingData['results'][number] =>
          typeof result?.title === 'string' &&
          typeof result.url === 'string' &&
          typeof result.snippet === 'string',
      ),
      ...(typeof details.data.error === 'string' && details.data.error
        ? { error: details.data.error }
        : {}),
      ...(typeof details.data.provider === 'string' && details.data.provider
        ? { provider: details.data.provider }
        : {}),
      ...(details.data.fallback === true ? { fallback: true } : {}),
    };
  }

  const sources = sourcePartsOf(message);
  if (sources.length === 0) return null;
  return {
    query: null,
    results: sources.map((source) => ({
      title: source.title ?? source.url,
      url: source.url,
      snippet: '',
    })),
  };
}

function faviconUrl(url: string): string | null {
  try {
    return new URL('/favicon.ico', url).toString();
  } catch {
    return null;
  }
}

function SourceMark({ url }: { url: string }) {
  const favicon = faviconUrl(url);
  return (
    <span className="relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded bg-[var(--bg-control)] text-[var(--text-muted)]">
      <Globe2 className="size-3.5" aria-hidden="true" />
      {favicon && (
        <img
          src={favicon}
          alt=""
          referrerPolicy="no-referrer"
          className="absolute inset-0 m-auto size-4 bg-[var(--bg-control)] object-contain"
          onError={(event) => event.currentTarget.remove()}
        />
      )}
    </span>
  );
}

/**
 * A reply's sources (v0.11): the search made before it (the pre-search, used
 * when the Search toggle is on and the model is not offered the web search
 * tool), and the links its tool calls returned. Both are shown as steps in
 * the reply's work block rather than as panels of their own.
 */
export interface SourceLink {
  url: string;
  title: string;
}
export interface ReplySearch {
  /** The search made before the reply; null when there was none. */
  presearch: SearchGroundingView | null;
  /** Links returned by the reply's tool calls (connectors, web search), without repeats. */
  sources: SourceLink[];
}

export function replySearchOf(message: UIMessage): ReplySearch {
  const leading: SourceLink[] = [];
  const fromTools: SourceLink[] = [];
  let toolSeen = false;
  for (const part of message.parts) {
    if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') toolSeen = true;
    if (part.type !== 'source-url') continue;
    const source = part as Partial<MessageSource>;
    if (!source.sourceId || !source.url) continue;
    // The pre-search's results are stored before any tool call.
    (toolSeen ? fromTools : leading).push({ url: source.url, title: source.title ?? source.url });
  }
  const details = message.parts.some((part) => part.type === 'data-search-grounding')
    ? searchGroundingOf(message)
    : null;
  const presearch =
    details ??
    (leading.length
      ? {
          query: null,
          results: leading.map((source) => ({ ...source, snippet: '' })),
        }
      : null);
  const known = new Set(presearch?.results.map((result) => result.url) ?? []);
  // A web search step lists its own results when expanded.
  for (const part of message.parts) {
    if (part.type !== 'tool-web_search') continue;
    const results = (part as { output?: { results?: unknown } }).output?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const url = (result as { url?: unknown } | null)?.url;
      if (typeof url === 'string') known.add(url);
    }
  }
  const sources = fromTools.filter((source) => {
    if (known.has(source.url)) return false;
    known.add(source.url);
    return true;
  });
  return { presearch, sources };
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** The pre-search's line in the work block: "Searched the web · 5 sources". */
function presearchLabel(grounding: SearchGroundingView): string {
  if (grounding.error) return 'Web search failed';
  return `Searched the web · ${count(grounding.results.length, 'source', 'sources')}`;
}

/**
 * While a reply waits for its pre-search: the work block's header as it will
 * read, active. Not a disclosure; it becomes the block when the reply starts.
 */
export function SearchLoading() {
  return (
    <div className="mb-4 flex items-center gap-2 text-[0.8125rem] font-medium text-[var(--text-primary)]">
      <Globe2 className="size-4 motion-safe:animate-pulse" aria-hidden="true" />
      <span role="status">Searching the web…</span>
    </div>
  );
}

/** Sources with their address and snippet, each opened through the external-link check. */
export function SourceList({ sources }: { sources: Array<SourceLink & { snippet?: string }> }) {
  return (
    <ul aria-label="Sources" className="space-y-1">
      {sources.map((source) => (
        <li key={source.url} className="min-w-0">
          <SafeExternalLink
            href={source.url}
            className="group flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--bg-control)]"
          >
            <SourceMark url={source.url} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[0.8125rem] font-medium text-[var(--text-primary)]">
                {source.title}
              </span>
              <span className="mt-0.5 block truncate text-[0.6875rem] text-[var(--text-muted)]">
                {source.url}
              </span>
              {source.snippet && (
                <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--text-secondary)]">
                  {source.snippet}
                </span>
              )}
            </span>
          </SafeExternalLink>
        </li>
      ))}
    </ul>
  );
}

/** A step in the work block that expands to its details, like a tool step. */
function StepDisclosure({
  label,
  icon: Icon,
  muted = false,
  children,
}: {
  label: string;
  icon: typeof Globe2;
  muted?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Icon
          className={cn('size-4 shrink-0', muted && 'text-[var(--warning)]')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 break-words">{label}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div id={detailsId} className="mt-2 space-y-3 text-xs text-[var(--text-secondary)]">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The pre-search as a step of the work block: "Searched the web · 5 sources",
 * expanding to the query, the provider that answered and the sources with
 * their snippets ("Web search failed" and why, when it failed).
 */
export function SearchStep({ grounding }: { grounding: SearchGroundingView }) {
  return (
    <StepDisclosure
      label={presearchLabel(grounding)}
      icon={grounding.error ? TriangleAlert : Globe2}
      muted={Boolean(grounding.error)}
    >
      <SearchDetails grounding={grounding} />
    </StepDisclosure>
  );
}

/**
 * What a web search found, as a reader wants it: the query, the provider that
 * answered and each source with its snippet. Shared by the search before a
 * reply and the model's own web_search steps (#203), which showed a JSON
 * object of inputs and bare titles instead.
 */
export function SearchDetails({ grounding }: { grounding: SearchGroundingView }) {
  return (
    <>
      <section>
        <h3 className="font-medium text-[var(--text-primary)]">Search query</h3>
        <p className="mt-1">{grounding.query ?? 'Query not retained for this older response'}</p>
      </section>
      {grounding.provider && (
        <section>
          <h3 className="font-medium text-[var(--text-primary)]">Search provider</h3>
          <p className="mt-1">
            {grounding.fallback
              ? `${grounding.provider} (the fallback provider; the first one did not answer)`
              : grounding.provider}
          </p>
        </section>
      )}
      {grounding.error ? (
        <p role="note">{grounding.error}</p>
      ) : (
        <section>
          <h3 className="mb-1 font-medium text-[var(--text-primary)]">Sources</h3>
          {grounding.results.length ? (
            <SourceList sources={grounding.results} />
          ) : (
            <p className="text-[var(--text-muted)]">No results.</p>
          )}
        </section>
      )}
    </>
  );
}

/** Links the reply's tool calls returned (connectors, web search), as one step. */
export function SourcesStep({ sources }: { sources: SourceLink[] }) {
  return (
    <StepDisclosure label={`Sources · ${count(sources.length, 'link', 'links')}`} icon={Link2}>
      <SourceList sources={sources} />
    </StepDisclosure>
  );
}

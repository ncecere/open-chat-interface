import type { SearchGroundingData } from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, ChevronRight, Globe2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
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

export function SearchLoading() {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-[var(--text-primary)]">
        <Globe2 className="size-4" aria-hidden="true" />
        Searched the web
      </div>
      <div role="status" className="ml-0.5 mt-7 flex gap-2" aria-label="Searching the web">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-2 animate-pulse rounded-full bg-[var(--text-muted)]"
            style={{ animationDelay: `${dot * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

export function SearchSourcesPanel({ grounding }: { grounding: SearchGroundingView }) {
  const [open, setOpen] = useState(false);

  if (grounding.error) {
    return (
      <div role="note" className="mb-7 text-[0.8125rem]">
        <p className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
          <TriangleAlert className="size-4 text-[var(--warning)]" aria-hidden="true" />
          Web search failed
        </p>
        <p className="mt-1 pl-6 text-[var(--text-muted)]">{grounding.error}</p>
      </div>
    );
  }

  return (
    <div className="mb-7">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-2 text-[0.8125rem] font-semibold text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Globe2 className="size-4" aria-hidden="true" />
        <span>Searched the web</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="mt-2 space-y-1 pl-6">
          {grounding.results.map((result) => (
            <SafeExternalLink
              key={result.url}
              href={result.url}
              className="group flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--bg-control)]"
            >
              <SourceMark url={result.url} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[0.8125rem] font-medium text-[var(--text-primary)]">
                  {result.title}
                </span>
                <span className="mt-0.5 block truncate text-[0.6875rem] text-[var(--text-muted)]">
                  {result.url}
                </span>
              </span>
            </SafeExternalLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function SearchGroundingDetails({ grounding }: { grounding: SearchGroundingView }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-8">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)] hover:text-[var(--text-secondary)]"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        Search Grounding Details
      </button>

      {open && (
        <div className="mt-5 space-y-5">
          <section>
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">Search Queries:</h3>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              {grounding.query ?? 'Query not retained for this older response'}
            </p>
          </section>

          <section>
            <h3 className="text-xs font-semibold text-[var(--text-primary)]">Search Results:</h3>
            <div className="mt-2 space-y-2">
              {grounding.results.map((result) => (
                <SafeExternalLink
                  key={result.url}
                  href={result.url}
                  className="block w-full rounded-lg bg-[var(--bg-control-alt)] px-3 py-3 text-left transition-colors hover:bg-[var(--bg-control-hover)]"
                >
                  <span className="block text-xs font-medium text-[var(--text-primary)]">
                    {result.title}
                  </span>
                  {result.snippet && (
                    <span className="mt-2 block line-clamp-2 text-xs leading-5 text-[var(--text-secondary)]">
                      {result.snippet}
                    </span>
                  )}
                </SafeExternalLink>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

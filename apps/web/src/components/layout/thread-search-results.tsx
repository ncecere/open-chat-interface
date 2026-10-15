import type { ThreadSearchResult } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { HighlightedText } from '~/components/search/highlighted-text';
import { Badge } from '~/components/ui/badge';
import { Spinner } from '~/components/ui/spinner';
import {
  searchResultsAnnouncement,
  searchResultTarget,
  useDebouncedValue,
  useThreadSearch,
} from '~/hooks/use-thread-search';
import { useLocale, useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/** One result: the title, an archived flag, and the best matching lines. */
export function SearchResultContent({ result }: { result: ThreadSearchResult }) {
  const t = useT();
  // The label is in the language of the page; the snippet keeps its own direction.
  const { dir } = useLocale();
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span dir="auto" className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
          <HighlightedText text={result.titleHighlight || result.thread.title} />
        </span>
        {result.thread.archived && (
          <Badge variant="outline" className="shrink-0 py-0 font-medium">
            {t('shell.search.archived')}
          </Badge>
        )}
      </span>
      {result.matches.map((match) => (
        <span
          key={match.messageId}
          dir="auto"
          className="mt-0.5 line-clamp-2 text-xs leading-snug text-[var(--text-muted)]"
        >
          {/* The label follows the page's direction whatever the snippet's language;
              skipped by dir="auto", which reads the snippet's own first letter (#360). */}
          <span dir={dir} className="font-medium">
            {t(match.role === 'user' ? 'shell.search.you' : 'shell.search.reply')}{' '}
          </span>
          <HighlightedText text={match.snippet} />
        </span>
      ))}
    </>
  );
}

/** Presentational list, separated from data loading so it can be tested directly. */
export function ThreadSearchResultList({
  results,
  activeThreadId,
}: {
  results: ThreadSearchResult[];
  activeThreadId?: string;
}) {
  const t = useT();
  return (
    <ul aria-label={t('shell.search.results')} className="flex flex-col gap-0.5">
      {results.map((result) => (
        <li key={result.thread.id}>
          <Link
            {...searchResultTarget(result)}
            data-search-result
            className={cn(
              'block rounded-lg px-2.5 py-2 text-sm text-[var(--text-secondary)] transition-colors',
              activeThreadId === result.thread.id
                ? 'bg-[var(--accent-soft)]'
                : 'hover:bg-[var(--bg-control)]',
            )}
          >
            <SearchResultContent result={result} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Sidebar search: titles and message text, best match first. Each result opens
 * the conversation at its best-matching message.
 */
export function ThreadSearchResults({ query }: { query: string }) {
  const t = useT();
  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed);
  const settled = debounced === trimmed;
  const { data: results, isFetching, isError, isPlaceholderData } = useThreadSearch(debounced);
  const params = useParams({ strict: false }) as { threadId?: string };
  const pending = !settled || (isFetching && (isPlaceholderData || !results));
  const announcement = pending || !results ? '' : searchResultsAnnouncement(results.length);

  return (
    <div className="flex flex-col gap-2">
      {/* Always mounted, so screen readers hear each settled count. */}
      <p role="status" aria-live="polite" className="sr-only">
        {isError ? t('shell.search.failed') : announcement}
      </p>

      {isError ? (
        <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
          {t('shell.search.unavailable')}
        </p>
      ) : !results ? (
        <div className="py-8">
          <Spinner className="mx-auto" />
        </div>
      ) : results.length === 0 ? (
        !pending && (
          <p className="px-2 py-8 text-center text-xs text-[var(--text-muted)]">
            {t('shell.search.noMatches')}
          </p>
        )
      ) : (
        <div aria-busy={pending || undefined} className={cn(pending && 'opacity-70')}>
          <ThreadSearchResultList results={results} activeThreadId={params.threadId} />
        </div>
      )}
    </div>
  );
}

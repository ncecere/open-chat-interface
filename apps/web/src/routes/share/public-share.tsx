import type { PublicArtifact } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Link2Off, LockKeyhole, MessageSquareText } from 'lucide-react';
import { PublicArtifactsProvider } from '~/components/artifacts/artifacts-provider';
import { CreatedArtifactCards, ReplyMarkdown } from '~/components/artifacts/reply-content';
import { Wordmark } from '~/components/brand/wordmark';
import { SafeExternalLink } from '~/components/chat/external-link-warning';
import { Markdown } from '~/components/chat/markdown';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

interface PublicTextPart {
  type: 'text';
  text: string;
}

interface PublicSourcePart {
  type: 'source-url';
  sourceId: string;
  url: string;
  title?: string;
}

/** A tool step as one summary line; the API never sends inputs or results. */
interface PublicToolStepPart {
  type: 'tool-step';
  toolId: string;
  summary: string;
}

type PublicPart = PublicTextPart | PublicSourcePart | PublicToolStepPart;

interface PublicShareResponse {
  thread: {
    title: string;
    sharedAt: string;
  };
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    parts: PublicPart[];
    createdAt: string;
  }>;
  /** Artifacts of the shared replies, at the shared version. Absent from older APIs. */
  artifacts?: PublicArtifact[];
  snapshot: boolean;
  expiresAt: string | null;
}

/** The share page's Markdown safety, also used for artifacts opened in the panel. */
const PUBLIC_MARKDOWN = { skipHtml: true, urlTransform: publicMarkdownUrl };

function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Blocks raw HTML, embedded images and non-http(s) markdown destinations. */
function publicMarkdownUrl(value: string, key: string): string | null {
  if (key !== 'href') return null;
  const safe = safeExternalUrl(value);
  if (!safe) return null;

  const url = new URL(safe);
  // Never turn private API or attachment paths embedded in message text into
  // anonymous links. Structured attachments are already omitted by the API.
  if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) return null;
  return url.toString();
}

function formatDate(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

function unavailableReason(error: unknown): 'expired' | 'revoked' | null {
  if (!(error instanceof ApiError) || error.status !== 410) return null;
  if (typeof error.details !== 'object' || error.details === null) return null;
  const reason = (error.details as { reason?: unknown }).reason;
  return reason === 'expired' || reason === 'revoked' ? reason : null;
}

function PublicShareState({
  title,
  description,
  retry,
}: {
  title: string;
  description: string;
  retry?: () => void;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-6 text-center shadow-[var(--shadow-popover)] sm:p-8">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-[var(--accent-soft)]">
          <Link2Off className="size-5 text-[var(--text-secondary)]" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-xl">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{description}</p>
        {retry && (
          <Button className="mt-5" type="button" variant="primary" onClick={retry}>
            Try again
          </Button>
        )}
      </section>
    </main>
  );
}

function Sources({ parts }: { parts: PublicPart[] }) {
  const sources = parts.flatMap((part) => {
    if (part.type !== 'source-url') return [];
    const url = safeExternalUrl(part.url);
    return url ? [{ ...part, url }] : [];
  });
  if (sources.length === 0) return null;

  return (
    <section className="mb-4 flex flex-wrap gap-2" aria-label="Sources">
      {sources.map((source) => {
        let hostname = source.url;
        try {
          hostname = new URL(source.url).hostname.replace(/^www\./, '');
        } catch {
          // safeExternalUrl already validated this URL.
        }

        return (
          <SafeExternalLink
            key={source.sourceId}
            href={source.url}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-control-hover)]"
          >
            <span className="truncate">{source.title || hostname}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </SafeExternalLink>
        );
      })}
    </section>
  );
}

function ToolStepSummaries({ parts }: { parts: PublicPart[] }) {
  const steps = parts.filter((part): part is PublicToolStepPart => part.type === 'tool-step');
  if (steps.length === 0) return null;
  return (
    <ul className="mb-3 space-y-1 text-xs text-[var(--text-muted)]" aria-label="Tool steps">
      {steps.map((step, index) => (
        // Summaries carry no stable id; the list is static once loaded.
        // biome-ignore lint/suspicious/noArrayIndexKey: never reordered.
        <li key={`${step.toolId}-${index}`} className="break-words">
          {step.summary}
        </li>
      ))}
    </ul>
  );
}

function SharedMessage({ message }: { message: PublicShareResponse['messages'][number] }) {
  const text = message.parts
    .filter((part): part is PublicTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

  if (
    !text &&
    !message.parts.some((part) => part.type === 'source-url' || part.type === 'tool-step')
  )
    return null;

  if (message.role === 'user') {
    return (
      <article className="flex flex-col items-end" aria-label="User message">
        <div className="max-w-[90%] rounded-2xl border border-[var(--border-user-message)] bg-[var(--bg-user-message)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)] sm:max-w-[85%]">
          <Markdown skipHtml urlTransform={publicMarkdownUrl}>
            {text}
          </Markdown>
        </div>
      </article>
    );
  }

  return (
    <article aria-label="Assistant message">
      <ToolStepSummaries parts={message.parts} />
      <Sources parts={message.parts} />
      {text && (
        <div className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
          <ReplyMarkdown
            messageId={message.id}
            text={text}
            skipHtml
            urlTransform={publicMarkdownUrl}
            className={cn(
              'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
              '[&_a]:text-[var(--accent-bright)] [&_a]:underline-offset-2',
              '[&_strong]:text-[var(--text-primary)]',
              '[&_code]:rounded [&_code]:bg-[var(--bg-control)] [&_code]:px-1 [&_code]:py-0.5',
              '[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
              '[&_hr]:border-[var(--border-subtle)]',
              '[&_li::marker]:text-[var(--accent-bright)]',
            )}
          />
        </div>
      )}
      <CreatedArtifactCards messageId={message.id} />
    </article>
  );
}

/** Standalone anonymous route component; router wiring is intentionally kept elsewhere. */
export function PublicSharePage({ slug }: { slug: string }) {
  const query = useQuery({
    queryKey: ['public-share', slug],
    queryFn: () => api.get<PublicShareResponse>(`/share-links/${encodeURIComponent(slug)}`),
    retry: false,
  });

  if (query.isLoading) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3" aria-busy="true">
        <Spinner className="size-6" />
        <p className="text-sm text-[var(--text-muted)]">Loading shared conversation…</p>
      </main>
    );
  }

  if (query.error) {
    const reason = unavailableReason(query.error);
    if (reason === 'expired') {
      return (
        <PublicShareState
          title="This share link has expired"
          description="The owner set an expiration time for this shared conversation."
        />
      );
    }
    if (reason === 'revoked') {
      return (
        <PublicShareState
          title="This share link was revoked"
          description="The owner has stopped sharing this conversation."
        />
      );
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <PublicShareState
          title="Shared conversation not found"
          description="Check the link, or ask its owner to create a new one."
        />
      );
    }
    return (
      <PublicShareState
        title="Could not load this conversation"
        description="A temporary error prevented the shared conversation from loading."
        retry={() => void query.refetch()}
      />
    );
  }

  if (!query.data) return null;
  const { thread, messages, expiresAt, snapshot } = query.data;
  const sharedAtLabel = formatDate(thread.sharedAt);
  const expiryLabel = expiresAt ? formatDate(expiresAt) : null;

  return (
    <div className="min-h-dvh bg-[var(--bg-root)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border-panel)] bg-[var(--bg-app)]/95 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Wordmark className="shrink-0" />
          <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <LockKeyhole className="size-3.5" aria-hidden="true" />
            Read-only share
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[42rem] px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        <section className="mb-9 border-b border-[var(--border-subtle)] pb-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
              <MessageSquareText
                className="size-4 text-[var(--text-secondary)]"
                aria-hidden="true"
              />
            </span>
            <div className="min-w-0">
              <h1 className="break-words text-xl sm:text-2xl">{thread.title}</h1>
              <p className="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                {snapshot ? 'Snapshot' : 'Live conversation'}
                {sharedAtLabel ? ` · Shared ${sharedAtLabel}` : ''}
                {expiryLabel ? ` · Expires ${expiryLabel}` : ''}
              </p>
            </div>
          </div>
        </section>

        {messages.length > 0 ? (
          <PublicArtifactsProvider
            artifacts={query.data.artifacts ?? []}
            markdownProps={PUBLIC_MARKDOWN}
          >
            <div className="flex flex-col gap-7">
              {messages.map((message) => (
                <SharedMessage key={message.id} message={message} />
              ))}
            </div>
          </PublicArtifactsProvider>
        ) : (
          <p className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 px-4 py-8 text-center text-sm text-[var(--text-muted)]">
            This shared conversation has no public messages.
          </p>
        )}
      </main>
    </div>
  );
}

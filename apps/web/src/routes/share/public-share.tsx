import { type PublicArtifact, toolLabel } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Globe2, LockKeyhole, MessageSquareText, Wrench } from 'lucide-react';
import { PublicArtifactsProvider } from '~/components/artifacts/artifacts-provider';
import { CreatedArtifactCards, ReplyMarkdown } from '~/components/artifacts/reply-content';
import { Wordmark } from '~/components/brand/wordmark';
import { SafeExternalLink } from '~/components/chat/external-link-warning';
import { MARKDOWN_PROSE, Markdown, useMarkdownRendererReady } from '~/components/chat/markdown';
import { partGroupsOf } from '~/components/chat/message-content';
import { WorkDisclosure } from '~/components/chat/reply-work';
import { type WorkStep, workSummary } from '~/components/chat/work-summary';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { ApiError, api } from '~/lib/api-client';
import { usePageTitle } from '~/lib/document-title';
import { messageExcerpt, repeatedOpeningPositions } from '~/lib/message-excerpt';

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

/**
 * A share that cannot be shown, in the layout of every unavailable page
 * (#113, #131), with a way on: the visitor may have no account, so the way
 * on is the app itself, which offers sign-in when needed.
 */
function PublicShareState({
  title,
  description,
  retry,
  appName,
}: {
  title: string;
  description: string;
  retry?: () => void;
  appName?: string;
}) {
  const home = (
    <Link to="/" className={retry ? 'text-sm underline' : undefined}>
      Go to {appName || 'Open Chat Interface'}
    </Link>
  );
  return (
    <main className="flex min-h-dvh flex-col">
      <UnavailableState
        className="flex-1"
        title={title}
        alert={Boolean(retry)}
        actions={
          retry ? (
            <>
              <Button type="button" onClick={retry}>
                Try again
              </Button>
              {home}
            </>
          ) : (
            <Button asChild>{home}</Button>
          )
        }
      >
        {description}
      </UnavailableState>
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

/** A shared step for the work summary: share links carry only its tool and summary line. */
function workStepOf(step: PublicToolStepPart): WorkStep {
  const used = /^Used (.+)$/.exec(step.summary)?.[1];
  return {
    toolId: step.toolId,
    label: used ?? toolLabel(step.toolId),
    state: / failed$/.test(step.summary)
      ? 'error'
      : / was not run( \(.*\))?$/.test(step.summary)
        ? 'denied'
        : 'done',
  };
}

/**
 * A shared reply's tool steps as one collapsed block, summarised as in the
 * conversation ("Searched the web twice"); expanded, each step's line.
 */
function SharedWork({ steps }: { steps: PublicToolStepPart[] }) {
  if (steps.length === 0) return null;
  const work = steps.map(workStepOf);
  return (
    <WorkDisclosure
      label={workSummary({ reasoning: false, steps: work })}
      icon={work.every((step) => step.toolId === 'web_search') ? Globe2 : Wrench}
      active={false}
      kind="work"
    >
      <ol
        aria-label="Steps"
        data-work-timeline=""
        className="mt-3 ml-2 space-y-2 border-l border-[var(--border-subtle)] pl-4 text-xs text-[var(--text-muted)]"
      >
        {steps.map((step, index) => (
          // Summaries carry no stable id; the list is static once loaded.
          // biome-ignore lint/suspicious/noArrayIndexKey: never reordered.
          <li key={`${step.toolId}-${index}`} className="break-words">
            {step.summary}
          </li>
        ))}
      </ol>
    </WorkDisclosure>
  );
}

type SharedMessageData = PublicShareResponse['messages'][number];

const sharedTextOf = (message: SharedMessageData) =>
  message.parts
    .filter((part): part is PublicTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

/** A message with nothing to show (no text, sources or steps) is left out. */
const isShown = (message: SharedMessageData) =>
  Boolean(sharedTextOf(message)) ||
  message.parts.some((part) => part.type === 'source-url' || part.type === 'tool-step');

function SharedMessage({
  message,
  position,
}: {
  message: SharedMessageData;
  /** Its place, when another message opens with the same words (#293). */
  position: string | null;
}) {
  const text = sharedTextOf(message);
  const excerpt = messageExcerpt(text) ?? undefined;
  const place = (excerpt && position) || undefined;

  if (message.role === 'user') {
    return (
      <article
        className="flex flex-col items-end"
        aria-label="User message"
        data-excerpt={excerpt}
        data-position={place}
      >
        <div className="max-w-[90%] rounded-2xl border border-[var(--border-user-message)] bg-[var(--bg-user-message)] px-4 py-3 text-[0.9375rem] leading-relaxed text-[var(--text-primary)] sm:max-w-[85%]">
          <Markdown skipHtml urlTransform={publicMarkdownUrl}>
            {text}
          </Markdown>
        </div>
      </article>
    );
  }

  return (
    // Its opening words name its code blocks and tables (#271).
    <article aria-label="Assistant message" data-excerpt={excerpt} data-position={place}>
      <Sources parts={message.parts} />
      {/* The work, then what it made, then the text in the order it was written. */}
      <SharedWork
        steps={message.parts.filter(
          (part): part is PublicToolStepPart => part.type === 'tool-step',
        )}
      />
      <CreatedArtifactCards messageId={message.id} />
      {partGroupsOf(message.parts, (part) => part.type === 'tool-step').map((group) =>
        group.type === 'text' ? (
          <div
            key={group.key}
            data-reply-group="text"
            className="mb-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] last:mb-0"
          >
            <ReplyMarkdown
              messageId={message.id}
              text={text}
              range={{ start: group.start, end: group.end }}
              skipHtml
              urlTransform={publicMarkdownUrl}
              // The owner's prose styling (#186): this page had a copy of its
              // own that gave block code the inline-code look.
              className={MARKDOWN_PROSE}
            />
          </div>
        ) : null,
      )}
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
  // `/auth/status` is public, so the header carries the instance's branding.
  const branding = useAuthStatus().data?.branding;
  usePageTitle(query.data?.thread.title);
  // Loaded beside the conversation, which shows once both are here, rather
  // than as Markdown source that jumps when the renderer arrives (#311).
  const rendererReady = useMarkdownRendererReady();

  if (query.isLoading || (query.data && !rendererReady)) {
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
          appName={branding?.appName}
          title="This share link has expired"
          description="The owner set an expiration time for this shared conversation."
        />
      );
    }
    if (reason === 'revoked') {
      return (
        <PublicShareState
          appName={branding?.appName}
          title="This share link was revoked"
          description="The owner has stopped sharing this conversation."
        />
      );
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <PublicShareState
          appName={branding?.appName}
          title="Shared conversation not found"
          description="Check the link, or ask its owner to create a new one."
        />
      );
    }
    return (
      <PublicShareState
        appName={branding?.appName}
        title="Could not load this conversation"
        description="A temporary error prevented the shared conversation from loading."
        retry={() => void query.refetch()}
      />
    );
  }

  if (!query.data) return null;
  const { thread, messages, expiresAt, snapshot } = query.data;
  const shown = messages.filter(isShown);
  // Messages that open with the same words are also named by their place (#293).
  const positions = repeatedOpeningPositions(
    shown.map((message) => ({
      role: message.role,
      excerpt: messageExcerpt(sharedTextOf(message)),
    })),
  );
  const sharedAtLabel = formatDate(thread.sharedAt);
  const expiryLabel = expiresAt ? formatDate(expiresAt) : null;

  return (
    <div className="min-h-dvh bg-[var(--bg-root)]">
      <header className="sticky top-0 z-20 border-b border-[var(--border-panel)] bg-[var(--bg-app)]/95 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Wordmark
            name={branding?.appName}
            shortName={branding?.shortName}
            logoUrl={branding?.logoUrl}
            compact
            className="min-w-0 shrink"
          />
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
              {shown.map((message, index) => (
                <SharedMessage
                  key={message.id}
                  message={message}
                  position={positions[index] ?? null}
                />
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

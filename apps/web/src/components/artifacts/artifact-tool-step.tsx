import { ARTIFACT_KIND_LABELS, type ToolStepSummary, toolKey } from '@oci/shared';
import { ArrowDown, ChevronDown, FileCode2, Wrench } from 'lucide-react';
import { type MouseEvent, useEffect, useId, useState } from 'react';
import { ArtifactCardButton, artifactMeta } from '~/components/artifacts/artifact-card';
import {
  type ArtifactDraft,
  artifactDraftOf,
  sizeLabel,
  writesSource,
} from '~/components/artifacts/artifact-drafts';
import {
  type ArtifactRef,
  type ArtifactsContextValue,
  useArtifacts,
} from '~/components/artifacts/artifacts-context';
import type { ToolPart } from '~/components/chat/tool-steps';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

/** How much of a live source the step's details show; the panel shows all of it. */
const LIVE_TAIL = 1_200;
/** How much of each find/replace text an edit shows. */
const EDIT_SNIPPET = 240;

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** The saved artifact a finished call made or changed, once the list has it. */
function savedRef(
  artifacts: ArtifactsContextValue | null,
  draft: ArtifactDraft,
): ArtifactRef | undefined {
  if (!artifacts || draft.state !== 'saved') return undefined;
  if (draft.tool === 'create_artifact')
    return artifacts.find(draft.messageId, toolKey(draft.toolCallId));
  return draft.artifactId ? artifacts.findById(draft.artifactId) : undefined;
}

/** How many of the last lines a live card shows. */
const PREVIEW_LINES = 3;
/** After this long without any text, a preparing card shows how long it has waited. */
const PREPARING_NOTICE_S = 3;

/** The last few lines written so far, without the trailing empty line, each clipped. */
function previewLines(content: string): string[] {
  const lines = content.replace(/\s+$/, '').split('\n');
  return lines.slice(-PREVIEW_LINES).map((line) => clip(line, 160));
}

/** Whole seconds since `active` last became true (0 while inactive), ticking each second. */
function useElapsedSeconds(active: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      return;
    }
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return active && startedAt !== null ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0;
}

/** "Writing Sales chart…", "Revising Sales chart… (2 changes)". */
function liveLabel(draft: ArtifactDraft, title: string | null): string {
  if (draft.mode === 'edits') {
    const count = draft.edits.length;
    return `Revising ${title ?? 'an artifact'}… (${count} ${count === 1 ? 'change' : 'changes'})`;
  }
  if (draft.mode === 'unknown') return `Revising ${title ?? 'an artifact'}…`;
  return title ? `Writing ${title}…` : 'Writing an artifact…';
}

/** A call that failed, or stopped before it was saved: only its row shows, with details. */
const isFailed = (draft: ArtifactDraft, streaming: boolean) =>
  draft.state === 'failed' || (draft.state === 'writing' && !streaming);

/** What an artifact call is about so far: from its input, its result, or the artifact it revises. */
function artifactStepOf(
  artifacts: ArtifactsContextValue | null,
  messageId: string,
  part: ToolPart,
  streaming: boolean,
) {
  const draft = artifactDraftOf(messageId, part);
  if (!draft) return null;
  const existing =
    draft.tool === 'update_artifact' && draft.artifactId
      ? artifacts?.findById(draft.artifactId)
      : undefined;
  const saved = savedRef(artifacts, draft);
  return {
    draft,
    existing,
    saved,
    title: draft.title ?? saved?.title ?? existing?.title ?? null,
    kind: draft.kind ?? saved?.kind ?? existing?.kind ?? null,
    writing: draft.state === 'writing' && streaming,
    failed: isFailed(draft, streaming),
  };
}

/** Whether an artifact call shows as its card below the work block; otherwise only as a row. */
export function showsArtifactCard(
  artifacts: ArtifactsContextValue | null,
  messageId: string,
  part: ToolPart,
  streaming: boolean,
): boolean {
  const draft = artifactDraftOf(messageId, part);
  return Boolean(artifacts && draft && !isFailed(draft, streaming));
}

/** The title an artifact call has so far, for the work block's "Writing …" header. */
export function artifactStepTitle(
  artifacts: ArtifactsContextValue | null,
  messageId: string,
  part: ToolPart,
): string | null {
  return artifactStepOf(artifacts, messageId, part, true)?.title ?? null;
}

/**
 * An artifact tool call in a reply, shown as its card below the reply's work
 * block rather than as a tool step plus a card that say the same thing. While
 * the model writes the artifact the card is live ("Writing Sales chart…") and
 * opens the panel on the source as it arrives; once saved it is the ordinary
 * card. A chevron at the card's right edge shows a readable summary of the
 * call inside the card (never its raw JSON input). A call that failed or
 * stopped has no card: its row in the work block has the same details.
 */
export function ArtifactToolStep({
  messageId,
  part,
  streaming,
}: {
  messageId: string;
  part: ToolPart;
  streaming: boolean;
}) {
  const artifacts = useArtifacts();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const info = artifactStepOf(artifacts, messageId, part, streaming);
  // Nothing written yet: the model may send its text in one piece at the end.
  const preparing = Boolean(
    streaming &&
      info?.draft.state === 'writing' &&
      info.draft.mode !== 'edits' &&
      info.draft.content.length === 0,
  );
  const waited = useElapsedSeconds(preparing);
  if (!info || !artifacts || info.failed) return null;
  const { draft, existing, saved, title, kind, writing } = info;
  const cardKey = toolKey(draft.toolCallId);
  const openDraft = artifacts.openDraft;

  let card: {
    title: string;
    meta: string;
    label: string;
    onOpen?: () => void;
    live: boolean;
    preview?: string[];
  };
  if (saved) {
    const created = draft.tool === 'create_artifact';
    // A revision opens the artifact; its card names the version this reply made.
    const shown = created ? saved : { ...saved, version: draft.version ?? saved.version };
    card = {
      title: saved.title,
      meta: `${created ? '' : 'Updated · '}${artifactMeta(shown)}`,
      label: `Open artifact: ${saved.title}`,
      onOpen: () => artifacts.open(shown),
      live: false,
    };
  } else if (draft.state === 'saved') {
    // Saved, and the conversation's list has not caught up yet: the panel
    // shows the source from the call until it does, then the artifact.
    const name = title ?? 'Artifact';
    card = {
      title: name,
      meta: `${kind ? ARTIFACT_KIND_LABELS[kind] : 'Artifact'}${draft.version ? ` · version ${draft.version}` : ''}`,
      label: `Open artifact: ${name}`,
      onOpen: openDraft ? () => openDraft(messageId, draft.toolCallId) : undefined,
      live: false,
    };
  } else {
    const kindLabel = kind ? `${ARTIFACT_KIND_LABELS[kind]} · ` : '';
    card = {
      title: preparing ? `Preparing ${title ?? 'artifact'}…` : liveLabel(draft, title),
      meta: preparing
        ? `${kindLabel}${waited >= PREPARING_NOTICE_S ? `waiting for text · ${waited} s` : 'starting'}`
        : draft.mode === 'content'
          ? `${kindLabel}${sizeLabel(draft.content)}`
          : `${kindLabel}revising`,
      label: `Open artifact while it is written: ${title ?? 'new artifact'}`,
      onOpen:
        writesSource(draft) && openDraft
          ? () => openDraft(messageId, draft.toolCallId)
          : existing
            ? () => artifacts.open(existing)
            : undefined,
      live: true,
      preview: draft.mode === 'content' && draft.content ? previewLines(draft.content) : undefined,
    };
  }

  return (
    <div
      className="min-w-0 max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/50"
      data-artifact-step={draft.toolCallId}
    >
      <div className="flex min-w-0 items-stretch">
        <ArtifactCardButton
          kind={kind}
          title={card.title}
          meta={card.meta}
          label={card.label}
          onOpen={card.onOpen}
          live={card.live}
          preview={card.preview}
          cardKey={cardKey}
          arrow={false}
          className="my-0 min-w-0 max-w-none flex-1 border-0 bg-transparent disabled:hover:bg-transparent"
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`Show details for ${title ?? 'artifact'}`}
          data-artifact-details-toggle=""
          onClick={() => setOpen(!open)}
          className="flex shrink-0 items-center rounded-xl px-3 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
        >
          <ChevronDown
            className={cn(
              'size-4 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      {open && (
        <div
          id={detailsId}
          data-artifact-details=""
          className="space-y-3 border-t border-[var(--border-subtle)] px-3 py-2.5 text-xs text-[var(--text-secondary)]"
        >
          <ArtifactStepDetails
            draft={draft}
            part={part}
            title={title}
            kind={kind}
            writing={writing}
            saved={saved}
            artifacts={artifacts}
          />
        </div>
      )}
    </div>
  );
}

/**
 * An artifact call in the work block's timeline: one line. When its card is
 * shown below the block the line points to it ("Created artifact 'Sales
 * chart'"); a call that failed or stopped, or one outside a conversation
 * page, expands to the call's details instead.
 */
export function ArtifactStepRow({
  messageId,
  part,
  step,
  streaming,
}: {
  messageId: string;
  part: ToolPart;
  step: ToolStepSummary;
  streaming: boolean;
}) {
  const artifacts = useArtifacts();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const info = artifactStepOf(artifacts, messageId, part, streaming);
  if (!info) return null;
  const { draft, title } = info;

  if (artifacts && !info.failed) {
    const label = draft.state === 'saved' ? step.summary : liveLabel(draft, title);
    const cardKey = toolKey(draft.toolCallId);
    const goToCard = (event: MouseEvent<HTMLButtonElement>) => {
      const card = event.currentTarget
        .closest('article')
        ?.querySelector<HTMLElement>(`[data-artifact-card="${CSS.escape(cardKey)}"]`);
      if (!card) return;
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      card.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
      card.focus({ preventScroll: true });
    };
    return (
      <button
        type="button"
        data-artifact-step-row={draft.toolCallId}
        onClick={goToCard}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <FileCode2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">
          {label}
          <span className="sr-only"> (go to its card)</span>
        </span>
        <ArrowDown className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
    );
  }

  const summary =
    draft.state === 'writing' && !streaming
      ? `${title ? `'${title}'` : 'The artifact'} was not finished`
      : step.summary;
  return (
    <div className="min-w-0" data-artifact-step={draft.toolCallId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Wrench className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{summary}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id={detailsId}
          className="mt-2 space-y-3 rounded-lg bg-black/10 px-3 py-2 text-xs text-[var(--text-secondary)]"
        >
          <ArtifactStepDetails
            draft={draft}
            part={part}
            title={title}
            kind={info.kind}
            writing={info.writing}
            saved={info.saved}
            artifacts={artifacts}
          />
        </div>
      )}
    </div>
  );
}

/**
 * What an artifact call did, readably: title, kind and size, each edit as a
 * before/after snippet, the live source while it is written, and a way to
 * open the artifact at the version this call made.
 */
function ArtifactStepDetails({
  draft,
  part,
  title,
  kind,
  writing,
  saved,
  artifacts,
}: {
  draft: ArtifactDraft;
  part: ToolPart;
  title: string | null;
  kind: ArtifactDraft['kind'];
  writing: boolean;
  saved: ArtifactRef | undefined;
  artifacts: ArtifactsContextValue | null;
}) {
  const size =
    draft.mode === 'content'
      ? sizeLabel(draft.content)
      : draft.mode === 'edits'
        ? `${draft.edits.length} ${draft.edits.length === 1 ? 'change' : 'changes'}`
        : null;
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-[var(--text-muted)]">Title</dt>
        <dd className="min-w-0 break-words">{title ?? '—'}</dd>
        <dt className="text-[var(--text-muted)]">Kind</dt>
        <dd>{kind ? ARTIFACT_KIND_LABELS[kind] : '—'}</dd>
        {size && (
          <>
            <dt className="text-[var(--text-muted)]">Size</dt>
            <dd>{size}</dd>
          </>
        )}
        {draft.version !== null && (
          <>
            <dt className="text-[var(--text-muted)]">Version</dt>
            <dd>{draft.version}</dd>
          </>
        )}
      </dl>
      {draft.mode === 'edits' && draft.edits.length > 0 && (
        <ol className="space-y-2" aria-label="Changes">
          {draft.edits.map((edit, index) => (
            // Edits only ever grow at the end while they stream.
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the edit's identity.
            <li key={index} className="space-y-1">
              <p className="text-[var(--text-muted)]">Change {index + 1}: replace</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/15 p-2 font-mono line-through decoration-[var(--text-muted)]/60">
                {clip(edit.find, EDIT_SNIPPET)}
              </pre>
              <p className="text-[var(--text-muted)]">with</p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/15 p-2 font-mono">
                {clip(edit.replace, EDIT_SNIPPET) || '(nothing)'}
              </pre>
            </li>
          ))}
        </ol>
      )}
      {writing && draft.mode === 'content' && draft.content && (
        <div className="space-y-1">
          <section
            aria-label="Latest source"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls; the keyboard must reach it.
            tabIndex={0}
            className="max-h-48 overflow-auto rounded bg-black/15 p-2 focus-visible:outline-2 focus-visible:outline-[var(--accent-bright)]"
          >
            <pre className="m-0 whitespace-pre-wrap break-words font-mono">
              {draft.content.length > LIVE_TAIL
                ? `…${draft.content.slice(-LIVE_TAIL)}`
                : draft.content}
            </pre>
          </section>
          {artifacts?.openDraft && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => artifacts.openDraft?.(draft.messageId, draft.toolCallId)}
            >
              Show in panel
            </Button>
          )}
        </div>
      )}
      {draft.state === 'failed' && (
        <p className="text-[var(--text-muted)]">
          {typeof part.errorText === 'string'
            ? part.errorText
            : part.state === 'output-denied'
              ? 'Not run.'
              : 'Not saved.'}
        </p>
      )}
      {saved && artifacts && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            artifacts.open({
              ...saved,
              ...(draft.version !== null ? { openVersion: draft.version } : {}),
            })
          }
        >
          {draft.version !== null ? `Open artifact (version ${draft.version})` : 'Open artifact'}
        </Button>
      )}
    </>
  );
}

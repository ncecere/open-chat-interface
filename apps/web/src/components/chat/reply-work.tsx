import { summarizeToolPart, type ToolStepSummary } from '@oci/shared';
import { Brain, ChevronDown, Globe2, type LucideIcon, Wrench } from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { ArtifactStepRow, artifactStepTitle } from '~/components/artifacts/artifact-tool-step';
import { useArtifacts } from '~/components/artifacts/artifacts-context';
import {
  isReasoningOnly,
  type ReplyLayout,
  type WorkEntry,
} from '~/components/chat/message-content';
import {
  ReasoningNote,
  ReasoningPreview,
  ReasoningText,
} from '~/components/chat/message-reasoning';
import { isArtifactStep, type ToolPart, ToolStepRow } from '~/components/chat/tool-steps';
import { type WorkStep, workActivity, workSummary } from '~/components/chat/work-summary';
import { useMediaQuery } from '~/hooks/use-media-query';
import { cn } from '~/lib/utils';

/**
 * The disclosure every work block is: a header button (the label, an icon,
 * a chevron) and, expanded, its content. Collapsed by default; expanding or
 * collapsing is the person's choice and wins for the rest of the reply. While
 * the model thinks and the person has not chosen, `preview` shows a small
 * window of the latest reasoning under the header.
 */
export function WorkDisclosure({
  label,
  icon: Icon,
  active,
  kind,
  preview,
  headerRef,
  children,
}: {
  label: string;
  icon: LucideIcon;
  /** The model is working now: the icon pulses (unless motion is reduced). */
  active: boolean;
  /** `reasoning` for a reply's single reasoning run, `work` for the block. */
  kind: 'reasoning' | 'work';
  /** The latest reasoning while the model is thinking. */
  preview?: string;
  headerRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? false;
  const panelId = useId();
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  return (
    <div
      className={kind === 'reasoning' ? 'mb-6' : 'mb-4'}
      data-reply-group={kind}
      data-reasoning={kind === 'reasoning' ? (active ? 'thinking' : 'done') : undefined}
      data-work={kind === 'work' ? (active ? 'active' : 'done') : undefined}
    >
      <button
        ref={headerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setChoice(!open)}
        className="flex w-fit max-w-full items-center gap-2 text-left text-[0.8125rem] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Icon
          aria-hidden="true"
          data-thinking-indicator={active ? '' : undefined}
          className={cn('size-4 shrink-0', active && !reduceMotion && 'motion-safe:animate-pulse')}
        />
        <span className="min-w-0 break-words">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {preview !== undefined && choice === null && (
        <ReasoningPreview text={preview} onExpand={() => setChoice(true)} />
      )}
      {open && <div id={panelId}>{children}</div>}
    </div>
  );
}

type Entry = WorkEntry<ToolPart>;

const workStepOf = (step: ToolStepSummary, part: ToolPart): WorkStep => ({
  toolId: step.toolId,
  label: step.label,
  state: step.state,
  target:
    typeof (part.input as { artifactId?: unknown } | undefined)?.artifactId === 'string'
      ? (part.input as { artifactId: string }).artifactId
      : null,
});

/**
 * Everything a reply did before its answer, as one block (v0.10.1).
 *
 * A reply with a single run of reasoning and no tool calls keeps the plain
 * "Reasoning" disclosure ("Thinking…" with its live window while it thinks).
 * Otherwise the header names the current activity while the model works
 * ("Thinking…", "Searching the web…", "Writing Sales chart…") and summarises
 * the work once the answer starts ("Thought · created an artifact"); expanded,
 * it is a timeline of the reasoning and tool calls in written order. Both are
 * the same element, so a reply that goes on from reasoning to a tool call
 * keeps the person's choice and focus.
 *
 * Step changes, not tokens, are announced politely.
 */
export function WorkBlock({
  messageId,
  layout,
  streaming,
  answeredHere,
}: {
  messageId: string;
  layout: ReplyLayout<ToolPart>;
  streaming: boolean;
  /** Steps whose approval was answered in this view: focus follows them here. */
  answeredHere: Set<string>;
}) {
  const artifacts = useArtifacts();
  const header = useRef<HTMLButtonElement>(null);
  const { work } = layout;
  const reasoningOnly = isReasoningOnly(work);
  const tools = work.flatMap((entry) =>
    entry.type === 'tool' ? [{ part: entry.part, step: summarizeToolPart(entry.part) }] : [],
  );
  const hasReasoning = work.some((entry) => entry.type === 'reasoning');

  // What the model is doing now; nothing once the answer has started or the reply ended.
  const thinking = streaming && layout.last === 'reasoning';
  let activity: ReturnType<typeof workActivity> | null = null;
  if (thinking) activity = workActivity({ type: 'reasoning' });
  else if (streaming && layout.last === 'tools' && layout.lastTool) {
    const step = summarizeToolPart(layout.lastTool);
    activity = workActivity({
      type: 'tool',
      step: workStepOf(step, layout.lastTool),
      title: isArtifactStep(step.toolId)
        ? artifactStepTitle(artifacts, messageId, layout.lastTool)
        : null,
    });
  }

  const label = reasoningOnly
    ? thinking
      ? 'Thinking…'
      : 'Reasoning'
    : (activity?.label ??
      workSummary({
        reasoning: hasReasoning,
        steps: tools.map(({ part, step }) => workStepOf(step, part)),
      }));
  const icon =
    hasReasoning || thinking
      ? Brain
      : tools.every(({ step }) => step.toolId === 'web_search')
        ? Globe2
        : Wrench;
  const latest = work.at(-1);
  const preview = thinking && latest?.type === 'reasoning' ? latest.text : undefined;

  // Announce each new activity of the block, never each token.
  const [announcement, setAnnouncement] = useState('');
  const brief = !reasoningOnly && activity ? activity.brief : '';
  useEffect(() => {
    if (brief) setAnnouncement(`${brief}…`);
  }, [brief]);

  // An approval answered here has moved into the block: keep focus nearby.
  const answered = tools
    .filter(({ step }) => answeredHere.has(step.toolCallId))
    .map(({ step }) => step.toolCallId)
    .join('\n');
  useEffect(() => {
    if (!answered) return;
    const lost = document.activeElement === document.body || !document.activeElement;
    if (lost && header.current?.getAttribute('aria-expanded') === 'false') header.current.focus();
  }, [answered]);

  return (
    <>
      <WorkDisclosure
        label={label}
        icon={icon}
        active={reasoningOnly ? thinking : activity !== null}
        kind={reasoningOnly ? 'reasoning' : 'work'}
        preview={preview}
        headerRef={header}
      >
        {reasoningOnly && latest?.type === 'reasoning' ? (
          <>
            <ReasoningText text={latest.text} className="mt-4" />
            <ReasoningNote />
          </>
        ) : (
          <>
            <WorkTimeline
              messageId={messageId}
              entries={work}
              streaming={streaming}
              answeredHere={answeredHere}
            />
            {hasReasoning && <ReasoningNote />}
          </>
        )}
      </WorkDisclosure>
      {!reasoningOnly && (
        <span role="status" aria-live="polite" className="sr-only">
          {streaming ? announcement : ''}
        </span>
      )}
    </>
  );
}

function WorkTimeline({
  messageId,
  entries,
  streaming,
  answeredHere,
}: {
  messageId: string;
  entries: readonly Entry[];
  streaming: boolean;
  answeredHere: Set<string>;
}) {
  return (
    <ol
      aria-label="Steps"
      data-work-timeline=""
      className="mt-3 ml-2 space-y-3 border-l border-[var(--border-subtle)] pl-4"
    >
      {entries.map((entry) => {
        if (entry.type === 'reasoning')
          return (
            <li key={entry.key} className="relative min-w-0" data-work-entry="reasoning">
              <TimelineDot />
              <span className="sr-only">Reasoning: </span>
              <ReasoningText text={entry.text} />
            </li>
          );
        const step = summarizeToolPart(entry.part);
        return (
          <li key={entry.key} className="relative min-w-0" data-work-entry="tool">
            <TimelineDot />
            {isArtifactStep(step.toolId) ? (
              <ArtifactStepRow
                messageId={messageId}
                part={entry.part}
                step={step}
                streaming={streaming}
              />
            ) : (
              <ToolStepRow
                part={entry.part}
                step={step}
                focusOnMount={answeredHere.has(step.toolCallId)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The mark on the timeline's line beside an entry; the entry itself says what it is. */
function TimelineDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute top-2 -left-[1.3rem] size-2 rounded-full border border-[var(--border-strong)] bg-[var(--bg-app)]"
    />
  );
}

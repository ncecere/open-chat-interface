import {
  ARTIFACT_TOOL_IDS,
  connectorSlugOfToolId,
  isToolPart,
  memoryChangeOf,
  summarizeToolPart,
  TOOL_LIMIT_REASONS,
  type ToolLimitReason,
  type ToolStepSummary,
  toolLimitNote,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, Globe2, ShieldQuestion, Wrench } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ArtifactToolStep } from '~/components/artifacts/artifact-tool-step';
import { MemoryNote } from '~/components/chat/memory-note';
import type { ToolPlace } from '~/components/chat/message-content';
import { SearchDetails, type SearchGroundingView } from '~/components/chat/search-grounding';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

export type AnswerApproval = (approvalId: string, approved: boolean) => void | PromiseLike<void>;

export type ToolPart = Record<string, unknown> & { type: string; toolCallId: string };

/** The tool parts of a message, with the summary every renderer shows. */
export function toolStepsOf(message: UIMessage): Array<{ part: ToolPart; step: ToolStepSummary }> {
  return message.parts.filter(isToolPart).map((part) => ({
    part: part as ToolPart,
    step: summarizeToolPart(part as ToolPart),
  }));
}

/** The note stored when a reply's tool loop ended early, if any. */
export function toolLimitOf(message: UIMessage): string | null {
  const part = message.parts.find((candidate) => candidate.type === 'data-tool-limit') as
    | { data?: { reason?: unknown; steps?: unknown } }
    | undefined;
  const reason = part?.data?.reason;
  if (!TOOL_LIMIT_REASONS.includes(reason as ToolLimitReason)) return null;
  return toolLimitNote(
    reason as ToolLimitReason,
    typeof part?.data?.steps === 'number' ? part.data.steps : undefined,
  );
}

const formatInput = (input: unknown) => {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input);
  }
};

function ResultSummary({ part, step }: { part: ToolPart; step: ToolStepSummary }) {
  if (step.state === 'error')
    return (
      <p className="text-[var(--text-muted)]">
        {typeof part.errorText === 'string' ? part.errorText : 'The tool failed.'}
      </p>
    );
  if (step.state === 'denied')
    return (
      <p className="text-[var(--text-muted)]">Not run{step.reason ? `: ${step.reason}` : ''}.</p>
    );
  if (step.state !== 'done') return null;
  return <p className="text-[var(--text-muted)]">Finished.</p>;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/**
 * A finished or failed `web_search` call as the search before a reply shows
 * it (#203): its query, the provider that answered, and each source with its
 * title, address and snippet, opened through the external-link check.
 */
function webSearchOf(part: ToolPart, step: ToolStepSummary): SearchGroundingView | null {
  if (step.toolId !== 'web_search' || (step.state !== 'done' && step.state !== 'error'))
    return null;
  const input = part.input as { query?: unknown } | undefined;
  const output = part.output as
    | { query?: unknown; results?: unknown; provider?: unknown; fallback?: unknown }
    | null
    | undefined;
  const results = Array.isArray(output?.results) ? output.results : [];
  const provider = text(output?.provider);
  return {
    query: text(output?.query) ?? text(input?.query),
    results: results.flatMap((result) => {
      const candidate = result as { url?: unknown; title?: unknown; snippet?: unknown } | null;
      return typeof candidate?.url === 'string' && /^https?:\/\//i.test(candidate.url)
        ? [
            {
              url: candidate.url,
              title: text(candidate.title) ?? candidate.url,
              snippet: text(candidate.snippet) ?? '',
            },
          ]
        : [];
    }),
    ...(step.state === 'error' ? { error: text(part.errorText) ?? 'The search failed.' } : {}),
    ...(provider ? { provider } : {}),
    ...(output?.fallback === true ? { fallback: true } : {}),
  };
}

/** One tool call: a one-line summary that expands to its inputs and a summary of its result. */
export function ToolStepRow({
  part,
  step,
  focusOnMount,
}: {
  part: ToolPart;
  step: ToolStepSummary;
  focusOnMount: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const button = useRef<HTMLButtonElement>(null);
  // After answering an approval the card is replaced by this row; keep focus
  // in the conversation instead of dropping it to the page.
  useEffect(() => {
    if (focusOnMount && (document.activeElement === document.body || !document.activeElement))
      button.current?.focus();
  }, [focusOnMount]);
  const Icon = step.toolId === 'web_search' ? Globe2 : Wrench;
  const search = webSearchOf(part, step);
  return (
    <div className="min-w-0">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[0.8125rem] text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Icon
          className={cn('size-4 shrink-0', step.state === 'running' && 'animate-pulse')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 break-words">{step.summary}</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && search && (
        <div id={detailsId} className="mt-2 space-y-3 text-xs text-[var(--text-secondary)]">
          <SearchDetails grounding={search} />
        </div>
      )}
      {open && !search && (
        <div
          id={detailsId}
          className="mt-2 space-y-2 rounded-lg bg-black/10 px-3 py-2 text-xs text-[var(--text-secondary)]"
        >
          <div>
            <p className="mb-1 font-medium text-[var(--text-primary)]">Inputs</p>
            <pre className="whitespace-pre-wrap break-words font-mono">
              {formatInput(part.input)}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-medium text-[var(--text-primary)]">Result</p>
            <ResultSummary part={part} step={step} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Asks the person to approve or deny a write tool call, showing the tool, its
 * connector and the exact inputs. Answers are announced, and focus stays on
 * the card's status once the buttons go.
 */
function ApprovalCard({
  part,
  step,
  onAnswer,
  disabled = false,
}: {
  part: ToolPart;
  step: ToolStepSummary;
  onAnswer?: AnswerApproval;
  disabled?: boolean;
}) {
  const titleId = useId();
  const inputsId = useId();
  const status = useRef<HTMLParagraphElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const answered = step.state === 'approved' || step.state === 'denied';
  // `mcp__<connector>__<tool>` names its connector; built-in tools have none.
  const connector = connectorSlugOfToolId(step.toolId);

  // Announced after mount: live regions ignore content present when they appear.
  useEffect(() => {
    if (!answered) setAnnouncement(`${step.label} is waiting for your approval.`);
  }, [answered, step.label]);

  const answer = (approved: boolean) => {
    if (!step.approvalId || !onAnswer) return;
    setAnnouncement(approved ? 'Approved. Continuing the reply.' : 'Denied. Continuing the reply.');
    void onAnswer(step.approvalId, approved);
    queueMicrotask(() => status.current?.focus());
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="tool-approval"
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-control)] p-3 text-sm sm:p-4"
    >
      <h3 id={titleId} className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
        <ShieldQuestion className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">Allow {step.label}?</span>
      </h3>
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)] sm:grid-cols-[auto_1fr]">
        <dt className="text-[var(--text-muted)]">Tool</dt>
        <dd className="min-w-0 break-words">{step.toolId}</dd>
        {connector && (
          <>
            <dt className="text-[var(--text-muted)]">Connector</dt>
            <dd className="min-w-0 break-words">{connector}</dd>
          </>
        )}
      </dl>
      <p id={inputsId} className="mt-2 text-xs text-[var(--text-muted)]">
        It will run with these inputs:
      </p>
      <pre
        aria-describedby={inputsId}
        className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/15 p-2 font-mono text-xs text-[var(--text-secondary)]"
      >
        {formatInput(part.input)}
      </pre>
      {!answered && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={disabled || !onAnswer}
            aria-describedby={titleId}
            onClick={() => answer(true)}
          >
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled || !onAnswer}
            aria-describedby={titleId}
            onClick={() => answer(false)}
          >
            Deny
          </Button>
        </div>
      )}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="mt-2 text-xs text-[var(--text-muted)] outline-none"
      >
        {answered
          ? step.state === 'approved'
            ? 'Approved. Continuing the reply…'
            : 'Denied.'
          : announcement}
      </p>
    </section>
  );
}

export const isArtifactStep = (toolId: string) =>
  (ARTIFACT_TOOL_IDS as readonly string[]).includes(toolId);

const isMemoryStep = (toolId: string) => toolId === 'remember' || toolId === 'forget';

/** A step the person answers, or has just answered, in its approval card. */
const isApprovalStep = (part: ToolPart, step: ToolStepSummary) =>
  step.state === 'awaiting-approval' ||
  ((step.state === 'approved' || step.state === 'denied') && part.state === 'approval-responded');

/**
 * Where a tool call shows in its reply. Artifact calls are a row in the work
 * block and their card below it (`showsCard` false, when the card cannot be
 * shown, leaves only the row). Approvals waiting for an answer and memory
 * changes stay below the block, in sight. Everything else is in the block.
 */
export function toolPlaceOf(part: ToolPart, showsCard: boolean): ToolPlace {
  const step = summarizeToolPart(part);
  if (isArtifactStep(step.toolId) && !step.approvalId && part.state !== 'approval-responded')
    return showsCard ? 'both' : 'work';
  if (isMemoryStep(step.toolId) || isApprovalStep(part, step)) return 'result';
  return 'work';
}

/**
 * What a reply's tool use made or needs, kept in sight between its work block
 * and its text: artifact cards (live while written), approvals waiting for
 * the person, memory notes with Undo, and the note when the reply hit a limit.
 */
export function ReplyResults({
  message,
  parts,
  onAnswer,
  disabled = false,
  streaming = false,
  answeredHere,
}: {
  message: UIMessage;
  /** The tool parts shown here, in written order. */
  parts: readonly ToolPart[];
  /** Absent for replies that can no longer be answered. */
  onAnswer?: AnswerApproval;
  disabled?: boolean;
  /** This reply is being written now. */
  streaming?: boolean;
  /** Steps whose approval was answered in this view, to keep focus with them. */
  answeredHere: Set<string>;
}) {
  const limit = toolLimitOf(message);
  if (parts.length === 0 && !limit) return null;
  const steps = parts.map((part) => ({ part, step: summarizeToolPart(part) }));
  const wrapped: AnswerApproval | undefined = onAnswer
    ? (approvalId, approved) => {
        const answered = steps.find(({ step }) => step.approvalId === approvalId);
        if (answered) answeredHere.add(answered.step.toolCallId);
        return onAnswer(approvalId, approved);
      }
    : undefined;
  return (
    <div className="mb-4 space-y-2" data-reply-results="">
      {steps.map(({ part, step }) => {
        // A saved or removed memory is shown with its text and Undo.
        const memory = memoryChangeOf(part);
        return (
          <div key={step.toolCallId} className="min-w-0">
            {isArtifactStep(step.toolId) &&
            !step.approvalId &&
            part.state !== 'approval-responded' ? (
              <ArtifactToolStep messageId={message.id} part={part} streaming={streaming} />
            ) : memory ? (
              <MemoryNote
                messageId={message.id}
                toolCallId={step.toolCallId}
                change={memory}
                canUndo={!disabled}
              />
            ) : isApprovalStep(part, step) ? (
              <ApprovalCard part={part} step={step} onAnswer={wrapped} disabled={disabled} />
            ) : (
              <ToolStepRow
                part={part}
                step={step}
                focusOnMount={answeredHere.has(step.toolCallId)}
              />
            )}
          </div>
        );
      })}
      {limit && (
        <p role="note" className="text-xs text-[var(--text-muted)]">
          {limit}
        </p>
      )}
    </div>
  );
}

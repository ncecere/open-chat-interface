import {
  isToolPart,
  summarizeToolPart,
  TOOL_LIMIT_REASONS,
  type ToolLimitReason,
  type ToolStepSummary,
  toolLimitNote,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, Globe2, ShieldQuestion, Wrench } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { SafeExternalLink } from '~/components/chat/external-link-warning';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

export type AnswerApproval = (approvalId: string, approved: boolean) => void | PromiseLike<void>;

type ToolPart = Record<string, unknown> & { type: string; toolCallId: string };

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

/** `mcp.<connector>.<tool>` names its connector; built-in tools have none. */
function connectorOf(toolId: string): string | null {
  const match = /^mcp\.([^.]+)\./.exec(toolId);
  return match?.[1] ?? null;
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
  const results = (part.output as { results?: unknown } | null)?.results;
  if (step.toolId === 'web_search' && Array.isArray(results)) {
    const links = results.flatMap((result) => {
      const candidate = result as { url?: unknown; title?: unknown } | null;
      return typeof candidate?.url === 'string' && /^https?:\/\//i.test(candidate.url)
        ? [
            {
              url: candidate.url,
              title: typeof candidate.title === 'string' ? candidate.title : candidate.url,
            },
          ]
        : [];
    });
    if (links.length === 0) return <p className="text-[var(--text-muted)]">No results.</p>;
    return (
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={link.url} className="min-w-0 truncate">
            <SafeExternalLink
              href={link.url}
              className="text-[var(--accent-bright)] underline-offset-2 hover:underline"
            >
              {link.title}
            </SafeExternalLink>
          </li>
        ))}
      </ul>
    );
  }
  return <p className="text-[var(--text-muted)]">Finished.</p>;
}

function ToolStepRow({
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
      {open && (
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
export function ApprovalCard({
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
  const connector = connectorOf(step.toolId);

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

/**
 * A reply's tool use: each call as a collapsed step, approvals inline in the
 * same place, and the note when the reply hit a limit.
 */
export const ToolSteps = memo(function ToolSteps({
  message,
  onAnswer,
  disabled = false,
}: {
  message: UIMessage;
  /** Absent for replies that can no longer be answered. */
  onAnswer?: AnswerApproval;
  disabled?: boolean;
}) {
  const steps = toolStepsOf(message);
  const limit = toolLimitOf(message);
  const answeredHere = useRef(new Set<string>());
  if (steps.length === 0 && !limit) return null;
  const wrapped: AnswerApproval | undefined = onAnswer
    ? (approvalId, approved) => {
        const answered = steps.find(({ step }) => step.approvalId === approvalId);
        if (answered) answeredHere.current.add(answered.step.toolCallId);
        return onAnswer(approvalId, approved);
      }
    : undefined;
  return (
    <div className="mb-4 space-y-2">
      {steps.length > 0 && (
        <ul className="space-y-2" aria-label="Tool steps">
          {steps.map(({ part, step }) => (
            <li key={step.toolCallId} className="min-w-0">
              {step.state === 'awaiting-approval' ||
              (step.state === 'approved' && part.state === 'approval-responded') ||
              (step.state === 'denied' && part.state === 'approval-responded') ? (
                <ApprovalCard part={part} step={step} onAnswer={wrapped} disabled={disabled} />
              ) : (
                <ToolStepRow
                  part={part}
                  step={step}
                  focusOnMount={answeredHere.current.has(step.toolCallId)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {limit && (
        <p role="note" className="text-xs text-[var(--text-muted)]">
          {limit}
        </p>
      )}
    </div>
  );
});

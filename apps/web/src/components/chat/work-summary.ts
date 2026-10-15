/**
 * The one-line label of a reply's work block: what the model did before it
 * answered, in a few words.
 *
 * - Reasoning alone: "Thought" ("Thought for 6s" when the time is known).
 * - Reasoning and one kind of tool use: "Thought · searched the web twice",
 *   "Thought · created an artifact", "Thought · used Service Desk lookup".
 * - Tool use alone, one kind: the activity itself, "Searched the web twice".
 * - A search made before the reply (v0.11) comes first, as it happened first:
 *   "Searched the web · thought", or "Searched the web" alone.
 * - More than one kind of tool use: "Worked · 3 steps" ("Worked for 12s · 3 steps").
 *
 * A kind is one activity: searching the web, creating artifacts, updating an
 * artifact, saving or removing memories, using one named tool, a failed step,
 * a step that was not run. Counts read "twice" and "3 times" for repeats of
 * one action, and "2 artifacts" where each made something new.
 */

import { type MessageKey, translate } from '~/lib/i18n';

export interface WorkStep {
  toolId: string;
  /** The tool's label, for example "Service Desk lookup". */
  label: string;
  /** `stopped`: still running when the reply ended, so it never finished. */
  state: 'running' | 'awaiting-approval' | 'approved' | 'done' | 'error' | 'denied' | 'stopped';
  /** What the step acted on, when known (the artifact an update revised). */
  target?: string | null;
  /** The search made before the reply, not a tool call (v0.11). */
  presearch?: boolean;
}

export interface WorkActivity {
  label: string;
  brief: string;
}

/** "searched the web twice": one phrase per kind of step, in the order first seen. */
function activityPhrases(steps: readonly WorkStep[]): string[] {
  const kinds = new Map<string, WorkStep[]>();
  for (const step of steps) {
    // A failed search says so, whether made before the reply or by the model
    // as a tool call: "a step failed" hid what failed (#143).
    const kind =
      step.state === 'error' && (step.presearch || step.toolId === 'web_search')
        ? 'search_failed'
        : step.state === 'error'
          ? 'failed'
          : step.state === 'denied'
            ? 'denied'
            : step.state === 'stopped'
              ? 'stopped'
              : step.toolId === 'web_search' ||
                  step.toolId === 'create_artifact' ||
                  step.toolId === 'update_artifact' ||
                  step.toolId === 'remember' ||
                  step.toolId === 'forget'
                ? step.toolId
                : `tool:${step.label}`;
    kinds.set(kind, [...(kinds.get(kind) ?? []), step]);
  }
  return [...kinds].map(([kind, group]) => {
    const count = group.length;
    switch (kind) {
      case 'search_failed':
        return translate('chat.work.searchFailed', { count });
      case 'failed':
        return translate('chat.work.failed', { count });
      case 'denied':
        return translate('chat.work.denied', { count });
      case 'stopped':
        // Not "created an artifact": a call stopped mid-way made nothing.
        return translate('chat.work.stopped', { count });
      case 'web_search':
        return translate('chat.work.searched', { count });
      case 'create_artifact':
        return translate('chat.work.created', { count });
      case 'update_artifact': {
        const targets = new Set(group.map((step) => step.target ?? null));
        // The same artifact revised again, or artifacts not known apart.
        if (targets.size === 1 && !targets.has(null))
          return translate('chat.work.updatedSame', { count });
        return translate('chat.work.updated', { count });
      }
      case 'remember':
        return translate('chat.work.remembered', { count });
      case 'forget':
        return translate('chat.work.forgot', { count });
      default:
        return group[0]?.label
          ? translate('chat.work.usedTool', { count, label: group[0].label })
          : translate('chat.work.usedUnnamedTool', { count });
    }
  });
}

/** The first letter capitalised, for a phrase that stands alone. */
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const wholeSeconds = (seconds: number | null | undefined): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 1
    ? Math.round(seconds)
    : null;

export function workSummary({
  reasoning,
  steps,
  seconds = null,
}: {
  /** Whether the work includes any reasoning. */
  reasoning: boolean;
  /** The tool steps, in order. */
  steps: readonly WorkStep[];
  /** How long the work took, when known; omitted from the label otherwise. */
  seconds?: number | null;
}): string {
  const phrases = activityPhrases(steps);
  const time = wholeSeconds(seconds);
  const timed = time === null ? {} : { seconds: time };
  if (phrases.length === 0)
    return translate(time === null ? 'chat.work.thought' : 'chat.work.thoughtFor', timed);
  if (phrases.length > 1)
    return translate(time === null ? 'chat.work.worked' : 'chat.work.workedFor', {
      ...timed,
      count: steps.length,
    });
  const [phrase = ''] = phrases;
  // The search before the reply happened before any thinking.
  if (reasoning && steps[0]?.presearch && steps.length === 1)
    return translate(
      time === null ? 'chat.work.phraseThenThought' : 'chat.work.phraseThenThoughtFor',
      { ...timed, phrase: capitalize(phrase) },
    );
  if (!reasoning) return capitalize(phrase);
  return translate(
    time === null ? 'chat.work.thoughtThenPhrase' : 'chat.work.thoughtForThenPhrase',
    {
      ...timed,
      phrase,
    },
  );
}

/**
 * The current activity while a reply works, for the block's header:
 * "Thinking…", "Searching the web…", "Writing Sales chart…". `brief` is the
 * same without names, for announcements that must not change with every
 * streamed character of a title.
 */
export function workActivity(
  current:
    | { type: 'reasoning' }
    | { type: 'tool'; step: WorkStep; title?: string | null }
    | { type: 'between' },
): WorkActivity {
  const plain = (label: MessageKey, brief: MessageKey): WorkActivity => ({
    label: translate(label),
    brief: translate(brief),
  });
  if (current.type === 'reasoning') return plain('chat.work.thinking', 'chat.work.thinkingBrief');
  if (current.type === 'between') return plain('chat.work.working', 'chat.work.workingBrief');
  const { step, title } = current;
  if (step.state === 'awaiting-approval')
    return plain('chat.work.awaitingApproval', 'chat.work.awaitingApprovalBrief');
  if (step.state !== 'running' && step.state !== 'approved')
    return plain('chat.work.working', 'chat.work.workingBrief');
  switch (step.toolId) {
    case 'web_search':
      return plain('chat.work.searching', 'chat.work.searchingBrief');
    case 'create_artifact':
      return title
        ? {
            label: translate('chat.work.writingTitled', { title }),
            brief: translate('chat.work.writingBrief'),
          }
        : plain('chat.work.writing', 'chat.work.writingBrief');
    case 'update_artifact':
      return title
        ? {
            label: translate('chat.work.revisingTitled', { title }),
            brief: translate('chat.work.revisingBrief'),
          }
        : plain('chat.work.revising', 'chat.work.revisingBrief');
    case 'remember':
      return plain('chat.work.saving', 'chat.work.savingBrief');
    case 'forget':
      return plain('chat.work.removing', 'chat.work.removingBrief');
    default:
      return {
        label: translate('chat.work.usingTool', { label: step.label }),
        brief: translate('chat.work.usingToolBrief', { label: step.label }),
      };
  }
}

/**
 * The message and the name when the header names something ("Writing Sales
 * chart…", "Using Service Desk lookup…"): the title or tool name is the person's,
 * the model's or a connector's text, so the header draws it in a `<bdi>` instead
 * of using `workActivity().label`.
 */
export function titledActivity(
  current: Parameters<typeof workActivity>[0],
): { key: MessageKey; name: 'title' | 'label'; value: string } | null {
  if (current.type !== 'tool') return null;
  const { step, title } = current;
  if (step.state !== 'running' && step.state !== 'approved') return null;
  if (title && step.toolId === 'create_artifact')
    return { key: 'chat.work.writingTitled', name: 'title', value: title };
  if (title && step.toolId === 'update_artifact')
    return { key: 'chat.work.revisingTitled', name: 'title', value: title };
  // Any other tool: its name, which a connector chose, in the sentence.
  if (step.toolId !== 'web_search' && !isOwnTool(step.toolId))
    return { key: 'chat.work.usingTool', name: 'label', value: step.label };
  return null;
}

/** The tools this release writes headers for itself ("Searching the web…", "Saving a memory…"). */
const isOwnTool = (toolId: string) =>
  ['web_search', 'create_artifact', 'update_artifact', 'remember', 'forget'].includes(toolId);

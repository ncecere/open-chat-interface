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

export interface WorkStep {
  toolId: string;
  /** The tool's label, for example "Service Desk lookup". */
  label: string;
  state: 'running' | 'awaiting-approval' | 'approved' | 'done' | 'error' | 'denied';
  /** What the step acted on, when known (the artifact an update revised). */
  target?: string | null;
  /** The search made before the reply, not a tool call (v0.11). */
  presearch?: boolean;
}

const times = (count: number) => (count === 1 ? '' : count === 2 ? ' twice' : ` ${count} times`);
const counted = (count: number, one: string, many: string) =>
  count === 1 ? one : `${count} ${many}`;

/** "searched the web twice": one phrase per kind of step, in the order first seen. */
function activityPhrases(steps: readonly WorkStep[]): string[] {
  const kinds = new Map<string, WorkStep[]>();
  for (const step of steps) {
    const kind =
      step.presearch && step.state === 'error'
        ? 'presearch_failed'
        : step.state === 'error'
          ? 'failed'
          : step.state === 'denied'
            ? 'denied'
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
      case 'presearch_failed':
        return 'web search failed';
      case 'failed':
        return count === 1 ? 'a step failed' : `${count} steps failed`;
      case 'denied':
        return count === 1 ? 'a step was not run' : `${count} steps were not run`;
      case 'web_search':
        return `searched the web${times(count)}`;
      case 'create_artifact':
        return `created ${counted(count, 'an artifact', 'artifacts')}`;
      case 'update_artifact': {
        const targets = new Set(group.map((step) => step.target ?? null));
        // The same artifact revised again, or artifacts not known apart.
        if (targets.size === 1 && !targets.has(null)) return `updated an artifact${times(count)}`;
        return `updated ${counted(count, 'an artifact', 'artifacts')}`;
      }
      case 'remember':
        return `saved ${counted(count, 'a memory', 'memories')}`;
      case 'forget':
        return `removed ${counted(count, 'a memory', 'memories')}`;
      default:
        return `used ${group[0]?.label ?? 'a tool'}${times(count)}`;
    }
  });
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const forSeconds = (seconds: number | null | undefined) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 1
    ? ` for ${Math.round(seconds)}s`
    : '';

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
  const time = forSeconds(seconds);
  if (phrases.length === 0) return `Thought${time}`;
  if (phrases.length > 1)
    return `Worked${time} · ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  const [phrase = ''] = phrases;
  // The search before the reply happened before any thinking.
  if (reasoning && steps[0]?.presearch && steps.length === 1)
    return `${capitalize(phrase)} · thought${time}`;
  return reasoning ? `Thought${time} · ${phrase}` : capitalize(phrase);
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
): { label: string; brief: string } {
  if (current.type === 'reasoning') return { label: 'Thinking…', brief: 'Thinking' };
  if (current.type === 'between') return { label: 'Working…', brief: 'Working' };
  const { step, title } = current;
  if (step.state === 'awaiting-approval')
    return { label: 'Waiting for your approval…', brief: 'Waiting for your approval' };
  if (step.state !== 'running' && step.state !== 'approved')
    return { label: 'Working…', brief: 'Working' };
  switch (step.toolId) {
    case 'web_search':
      return { label: 'Searching the web…', brief: 'Searching the web' };
    case 'create_artifact':
      return {
        label: title ? `Writing ${title}…` : 'Writing an artifact…',
        brief: 'Writing an artifact',
      };
    case 'update_artifact':
      return {
        label: title ? `Revising ${title}…` : 'Revising an artifact…',
        brief: 'Revising an artifact',
      };
    case 'remember':
      return { label: 'Saving a memory…', brief: 'Saving a memory' };
    case 'forget':
      return { label: 'Removing a memory…', brief: 'Removing a memory' };
    default:
      return { label: `Using ${step.label}…`, brief: `Using ${step.label}` };
  }
}

import type { UIMessage } from 'ai';

/** The responding model and effort, sent as stream metadata and persisted per message. */
export function metadataOf(message: UIMessage): {
  modelSlug: string | null;
  effort: string | null;
  status: string | null;
  errorMessage: string | null;
} {
  const metadata = message.metadata as
    | { modelSlug?: unknown; effort?: unknown; status?: unknown; errorMessage?: unknown }
    | undefined;
  return {
    modelSlug: typeof metadata?.modelSlug === 'string' ? metadata.modelSlug : null,
    effort: typeof metadata?.effort === 'string' ? metadata.effort : null,
    status: typeof metadata?.status === 'string' ? metadata.status : null,
    errorMessage:
      typeof metadata?.errorMessage === 'string' && metadata.errorMessage
        ? metadata.errorMessage
        : null,
  };
}

/**
 * Why a saved reply stopped early without the person stopping it (v0.11): the
 * server writing it shut down or crashed. The server stores such a reply as
 * cancelled with a reason; one the person stopped has none.
 */
export function interruptionOf(message: UIMessage): string | null {
  const { status, errorMessage } = metadataOf(message);
  return message.role === 'assistant' && status === 'cancelled' ? errorMessage : null;
}

export function contextLimitedOf(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === 'data-context-window' &&
      typeof part.data === 'object' &&
      part.data !== null &&
      'limited' in part.data &&
      part.data.limited === true,
  );
}

export function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function reasoningOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'reasoning'; text: string } => part.type === 'reasoning')
    .map((part) => part.text)
    .join('\n');
}

/**
 * A reply's parts as the conversation shows them, in the order they were
 * written: runs of reasoning, of tool calls and of text, each run one group.
 * Other parts (step boundaries, sources, data) do not end a run. Text groups
 * are ranges of `textOf(message)` (text parts joined by a newline), so a
 * group's artifact blocks keep the keys detection gave them in the whole text.
 * Empty text and reasoning (a model that hides its reasoning) make no group.
 */
export type PartGroup<P> =
  | { type: 'reasoning'; key: string; text: string }
  | { type: 'tools'; key: string; parts: P[] }
  | { type: 'text'; key: string; start: number; end: number };

export function partGroupsOf<P extends { type: string }>(
  parts: readonly P[],
  isTool: (part: P) => boolean,
): PartGroup<P>[] {
  const groups: PartGroup<P>[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    const last = groups.at(-1);
    const value = (part as { text?: unknown }).text;
    const text = typeof value === 'string' ? value : '';
    if (part.type === 'text' && typeof value === 'string') {
      const start = offset;
      const end = start + text.length;
      offset = end + 1;
      if (!text.trim()) return;
      if (last?.type === 'text') last.end = end;
      else groups.push({ type: 'text', key: `text-${index}`, start, end });
    } else if (part.type === 'reasoning') {
      if (!text.trim()) return;
      if (last?.type === 'reasoning') last.text = `${last.text}\n${text}`;
      else groups.push({ type: 'reasoning', key: `reasoning-${index}`, text });
    } else if (isTool(part)) {
      if (last?.type === 'tools') last.parts.push(part);
      else groups.push({ type: 'tools', key: `tools-${index}`, parts: [part] });
    }
  });
  return groups;
}

/** Where a tool call shows: in the work block, outside it (a card, an approval, a memory note), or both. */
export type ToolPlace = 'work' | 'result' | 'both';

export type WorkEntry<P> =
  | { type: 'reasoning'; key: string; text: string }
  | { type: 'tool'; key: string; part: P };

/**
 * A reply laid out as the conversation shows it (v0.10.1):
 *
 * - `work`: everything the model did before answering, every reasoning run
 *   and tool call of every step, in written order. One block shows it.
 * - `results`: tool calls whose outcome must stay in sight below that block:
 *   artifact cards, approvals waiting for an answer, memory notes.
 * - `text`: the reply's text runs, in order, below both.
 *
 * `last` is the kind of the latest group, so a streaming reply knows whether
 * it is thinking, using a tool or answering; `lastTool` is its latest tool call.
 */
export interface ReplyLayout<P> {
  work: WorkEntry<P>[];
  results: P[];
  text: Array<{ key: string; start: number; end: number }>;
  last: 'reasoning' | 'tools' | 'text' | null;
  lastTool: P | null;
}

export function replyLayoutOf<P extends { type: string }>(
  parts: readonly P[],
  isTool: (part: P) => boolean,
  placeOf: (part: P) => ToolPlace,
  keyOf: (part: P) => string,
): ReplyLayout<P> {
  const layout: ReplyLayout<P> = { work: [], results: [], text: [], last: null, lastTool: null };
  for (const group of partGroupsOf(parts, isTool)) {
    layout.last = group.type;
    if (group.type === 'reasoning')
      layout.work.push({ type: 'reasoning', key: group.key, text: group.text });
    else if (group.type === 'text')
      layout.text.push({ key: group.key, start: group.start, end: group.end });
    else {
      for (const part of group.parts) {
        const place = placeOf(part);
        if (place !== 'result') layout.work.push({ type: 'tool', key: keyOf(part), part });
        if (place !== 'work') layout.results.push(part);
      }
      layout.lastTool = group.parts.at(-1) ?? null;
    }
  }
  return layout;
}

/** One reasoning run and nothing else: shown as the plain "Reasoning" disclosure. */
export const isReasoningOnly = (work: readonly WorkEntry<unknown>[]) =>
  work.length === 1 && work[0]?.type === 'reasoning';

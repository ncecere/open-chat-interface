import type { UIMessage } from 'ai';

/** The responding model and effort, sent as stream metadata and persisted per message. */
export function metadataOf(message: UIMessage): {
  modelSlug: string | null;
  effort: string | null;
  status: string | null;
} {
  const metadata = message.metadata as
    | { modelSlug?: unknown; effort?: unknown; status?: unknown }
    | undefined;
  return {
    modelSlug: typeof metadata?.modelSlug === 'string' ? metadata.modelSlug : null,
    effort: typeof metadata?.effort === 'string' ? metadata.effort : null,
    status: typeof metadata?.status === 'string' ? metadata.status : null,
  };
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

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

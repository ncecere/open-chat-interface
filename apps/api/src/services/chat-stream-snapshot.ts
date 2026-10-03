/**
 * A compact copy of a reply's stream so far (v0.10), for replaying a reply
 * whose stored events were trimmed (Redis keeps a bounded number per reply).
 *
 * Replaying it gives the AI SDK client the same message as replaying every
 * event: consecutive text, reasoning and tool-input deltas of one part are
 * merged into one delta, and a tool call's input deltas are dropped once its
 * full input has arrived (the client replaces the draft with it). Everything
 * else (start, steps, tool results, data and source parts) is kept as it was,
 * in order. The draft of an artifact still being written is therefore one
 * `tool-input-delta` carrying all of its input so far.
 */

type DeltaKind = 'text' | 'reasoning' | 'tool-input';

interface DeltaEntry {
  kind: DeltaKind;
  /** The chunk without its delta text; the merged text is added back when written. */
  chunk: Record<string, unknown>;
  parts: string[];
}

type Entry = { frame: string } | DeltaEntry;

const DELTA_FIELD: Record<DeltaKind, string> = {
  text: 'delta',
  reasoning: 'delta',
  'tool-input': 'inputTextDelta',
};

function parseFrame(frame: string): Record<string, unknown> | null {
  if (!frame.startsWith('data: ') || !frame.endsWith('\n\n')) return null;
  try {
    const value: unknown = JSON.parse(frame.slice(6, -2));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function deltaOf(chunk: Record<string, unknown>): { kind: DeltaKind; id: string } | null {
  switch (chunk.type) {
    case 'text-delta':
      return typeof chunk.id === 'string' && typeof chunk.delta === 'string'
        ? { kind: 'text', id: chunk.id }
        : null;
    case 'reasoning-delta':
      return typeof chunk.id === 'string' && typeof chunk.delta === 'string'
        ? { kind: 'reasoning', id: chunk.id }
        : null;
    case 'tool-input-delta':
      return typeof chunk.toolCallId === 'string' && typeof chunk.inputTextDelta === 'string'
        ? { kind: 'tool-input', id: chunk.toolCallId }
        : null;
    default:
      return null;
  }
}

/** The part a chunk ends (after which its deltas are no longer merged), if any. */
function endedPart(chunk: Record<string, unknown>): string | null {
  switch (chunk.type) {
    case 'text-end':
    case 'text-start':
      return typeof chunk.id === 'string' ? `text:${chunk.id}` : null;
    case 'reasoning-end':
    case 'reasoning-start':
      return typeof chunk.id === 'string' ? `reasoning:${chunk.id}` : null;
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error':
      return typeof chunk.toolCallId === 'string' ? `tool-input:${chunk.toolCallId}` : null;
    default:
      return null;
  }
}

export class ReplaySnapshot {
  private readonly entries: Entry[] = [];
  /** The open delta entry of each part, by `kind:id`. */
  private readonly open = new Map<string, DeltaEntry>();
  private observedFrames = 0;

  /** Adds the next frame of the stream, in order. */
  observe(frame: string): void {
    this.observedFrames++;
    const chunk = parseFrame(frame);
    const delta = chunk ? deltaOf(chunk) : null;
    if (chunk && delta) {
      const key = `${delta.kind}:${delta.id}`;
      const text = chunk[DELTA_FIELD[delta.kind]] as string;
      const entry = this.open.get(key);
      if (entry) {
        entry.parts.push(text);
        // The newest provider metadata wins, as the client keeps the last one.
        if (chunk.providerMetadata !== undefined)
          entry.chunk.providerMetadata = chunk.providerMetadata;
        return;
      }
      const { [DELTA_FIELD[delta.kind]]: _text, ...rest } = chunk;
      const created: DeltaEntry = { kind: delta.kind, chunk: rest, parts: [text] };
      this.open.set(key, created);
      this.entries.push(created);
      return;
    }
    const ended = chunk ? endedPart(chunk) : null;
    if (ended) {
      const entry = this.open.get(ended);
      this.open.delete(ended);
      // The full input replaces the draft on the client: its deltas are redundant.
      if (entry && chunk?.type === 'tool-input-available') {
        const index = this.entries.lastIndexOf(entry);
        if (index >= 0) this.entries.splice(index, 1);
      }
    }
    this.entries.push({ frame });
  }

  /** How many frames it stands for. */
  get size(): number {
    return this.observedFrames;
  }

  /** The frames to replay in place of every frame observed so far. */
  frames(): string[] {
    return this.entries.map((entry) => {
      if ('frame' in entry) return entry.frame;
      const chunk = { ...entry.chunk, [DELTA_FIELD[entry.kind]]: entry.parts.join('') };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    });
  }
}

/** A stored snapshot: the frames standing for events 1..`sequence`. */
export interface StoredSnapshot {
  sequence: number;
  frames: string[];
}

export function parseStoredSnapshot(value: string | null): StoredSnapshot | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const { sequence, frames } = parsed as Record<string, unknown>;
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !Array.isArray(frames) ||
      !frames.every((frame) => typeof frame === 'string')
    )
      return null;
    return { sequence, frames: frames as string[] };
  } catch {
    return null;
  }
}

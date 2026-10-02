import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from '@oci/shared';

interface HighlightSegment {
  /** Offset in the marker-free text; stable, so it doubles as a React key. */
  start: number;
  text: string;
  highlighted: boolean;
}

/**
 * Splits a search snippet into plain and matched runs.
 *
 * The server marks matches with control characters, never HTML, so the result
 * is rendered as text nodes and anything that looks like markup in a message
 * stays visible as text. Unbalanced markers are tolerated: a stray end marker
 * is dropped and an unclosed start marker highlights to the end.
 */
export function parseHighlights(value: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let current = '';
  let highlighted = false;
  let offset = 0;

  const flush = () => {
    if (current) segments.push({ start: offset - current.length, text: current, highlighted });
    current = '';
  };

  for (const character of value) {
    if (character === SEARCH_HIGHLIGHT_START || character === SEARCH_HIGHLIGHT_END) {
      const opens = character === SEARCH_HIGHLIGHT_START;
      if (opens !== highlighted) {
        flush();
        highlighted = opens;
      }
      continue;
    }
    current += character;
    offset += character.length;
  }
  flush();
  return segments;
}

/** The snippet as plain text, for titles and accessible names. */
export function stripHighlights(value: string): string {
  return value.replaceAll(SEARCH_HIGHLIGHT_START, '').replaceAll(SEARCH_HIGHLIGHT_END, '');
}

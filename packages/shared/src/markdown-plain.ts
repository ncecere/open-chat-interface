/**
 * Markdown as the words a reader sees, for places that show a message as one
 * line of plain text: conversation-search snippets (#206) and the short
 * excerpts that name a message's controls (#194). Not a Markdown parser: it
 * works on fragments too (a search snippet starts and ends mid-sentence), so
 * each rule only removes syntax it can recognise locally, and anything it
 * cannot place stays as text.
 *
 * Characters other than Markdown syntax are kept exactly, so the search
 * highlight markers (U+0001, U+0002) survive and still surround their words.
 */

/** Inline code spans, kept apart so their text is never treated as syntax. */
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** Whitespace or punctuation around emphasis markers; highlight markers count as text. */
const OPEN_BEFORE = `(^|[\\s([{"'“‘—–-])`;
const CLOSE_AFTER = `(?=$|[\\s)\\]}"'”’.,;:!?—–-])`;
const EMPHASIS_OPEN = new RegExp(`${OPEN_BEFORE}(?:\\*{1,3}|_{1,3}|~~)(?=[^\\s*_~])`, 'g');
const EMPHASIS_CLOSE = new RegExp(`(?<=[^\\s*_~])(?:\\*{1,3}|_{1,3}|~~)${CLOSE_AFTER}`, 'g');

/** Escaped characters are set aside while the syntax goes, then shown as themselves. */
const ESCAPED = 0xe000;

function inlineText(text: string): string {
  return (
    text
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_match, character: string) =>
        String.fromCharCode(ESCAPED + character.charCodeAt(0)),
      )
      // Images and links keep their words: ![alt](src), [text](href), [text][ref].
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      .replace(EMPHASIS_OPEN, '$1')
      .replace(EMPHASIS_CLOSE, '')
      .replace(/[\ue000-\ue07f]/g, (character) =>
        String.fromCharCode(character.charCodeAt(0) - ESCAPED),
      )
  );
}

function lineText(line: string): string | null {
  // Fences, rules and table delimiter rows say nothing to a reader.
  if (/^\s*(```|~~~)/.test(line)) return null;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*=+\s*$/.test(line)) return null;
  if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-')) return null;
  let text = line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*(>\s?)+/, '')
    // Bullets go; numbered items keep their number, which is part of the text.
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^(\s*\d+[.)]\s+)\[[ xX]\]\s+/, '$1');
  // A table row reads as its cells.
  if (/^\s*\|.*\|\s*$/.test(text))
    text = text
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' · ');
  return text;
}

export function plainTextOfMarkdown(markdown: string): string {
  const lines = markdown.split('\n').flatMap((line) => {
    const text = lineText(line);
    return text === null ? [] : [text];
  });
  const joined = lines.join('\n');
  // Code spans keep their text verbatim, without the backticks.
  let result = '';
  let last = 0;
  for (const match of joined.matchAll(CODE_SPAN)) {
    result += inlineText(joined.slice(last, match.index)) + (match[2] ?? '').trim();
    last = (match.index ?? 0) + match[0].length;
  }
  result += inlineText(joined.slice(last));
  // A code span cut in half by a fragment leaves a stray backtick.
  return result.replace(/`+/g, '');
}

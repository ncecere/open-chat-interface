/**
 * Markdown with every heading `levels` lower, at most h6 (#255). In a
 * conversation's Markdown download the speakers are h2 ("## You",
 * "## Assistant · …"), so a reply's own "## Colours" was their sibling, and
 * its "# Title" ranked above them: an outline or a viewer's table of contents
 * showed the reply's sections as further turns. Demoted by two, they sit
 * under their speaker, as replies' headings do on screen (#212).
 *
 * Line by line, without a Markdown parser: fenced code is left as it is (a
 * "# comment" in a shell script is not a heading); ATX headings, also inside
 * block quotes, gain `levels` hashes; a one-line setext heading (text
 * underlined with `=` or `-`) becomes an ATX heading at its demoted level.
 */
export function demoteHeadings(markdown: string, levels: number): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.char && marker.length >= fence.length && !FENCE_INFO.test(line))
        fence = null;
      out.push(line);
      continue;
    }
    if (marker) {
      fence = { char: marker[0]!, length: marker.length };
      out.push(line);
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      const [whole, prefix, hashes] = atx;
      const level = Math.min(6, hashes!.length + levels);
      out.push(`${prefix}${'#'.repeat(level)}${line.slice(whole.length)}`);
      continue;
    }
    const underline = SETEXT.exec(lines[index + 1] ?? '');
    const previous = out.at(-1);
    if (underline && isParagraphText(line) && (previous === undefined || !previous.trim())) {
      const level = Math.min(6, (underline[1]!.startsWith('=') ? 1 : 2) + levels);
      out.push(`${'#'.repeat(level)} ${line.trim()}`);
      index++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** A code fence opening or closing, after any indent or block-quote markers. */
const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;
/** A fence followed by an info string, which only an opening fence has. */
const FENCE_INFO = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:`{3,}|~{3,})[ \t]*\S/;
/** An ATX heading: up to three spaces (after block-quote markers), 1–6 hashes, then a space or nothing. */
const ATX = /^((?:[ ]{0,3}>[ \t]?)*[ ]{0,3})(#{1,6})(?=[ \t]|$)/;
const SETEXT = /^[ ]{0,3}(=+|-+)[ \t]*$/;

/** A line that can be a setext heading's text: not a list item, quote, table row or blank. */
function isParagraphText(line: string): boolean {
  if (!line.trim() || /^[ ]{4,}/.test(line)) return false;
  return !/^[ ]{0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|\||<|#)/.test(line);
}

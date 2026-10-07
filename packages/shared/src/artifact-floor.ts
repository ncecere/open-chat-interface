import { fencedBlocks } from './artifacts.js';
import { ARTIFACT_NOT_SAVED } from './tools.js';

/**
 * A floor under Markdown artifacts (#149). The guidance and the tool's own
 * description say a Markdown artifact is for a long prose document the person
 * asked for, and that program code stays in the reply; the instance's default
 * model still saved a three-row table and a three-line function as two
 * "Document" artifacts, and wrote both in its reply too. So `create_artifact`
 * declines them unless the person asked for an artifact, and the model is told
 * to keep the content in its reply. A short static HTML page is held to the
 * same floor (#313, below).
 *
 * Shared (#201): the conversation hides such an attempt rather than showing it
 * as a failed step, and does not open the artifact panel for a Markdown
 * document that, as written so far, would be declined.
 */

/** Text outside code blocks a Markdown artifact needs: a few paragraphs. */
export const MIN_MARKDOWN_ARTIFACT_CHARS = 500;

export const SHORT_MARKDOWN_REFUSAL = `${ARTIFACT_NOT_SAVED}: short content such as a table, a list or a few paragraphs belongs in your reply. Write it in your reply once (do not repeat it if you already have).`;

export const CODE_MARKDOWN_REFUSAL = `${ARTIFACT_NOT_SAVED}: program code belongs in fenced code blocks in your reply, not in a document. Write it in your reply once (do not repeat it if you already have).`;

/** A GFM table's delimiter row: `| --- | :---: |` or `--- | ---`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/**
 * The text of Markdown outside its code blocks that reads as prose (#313).
 * Everything outside code once counted, so a Markdown table, the URL of a
 * link and the `#`, `-` and `1.` of headings and lists did too: a 710-byte
 * answer of a heading, a three-row table, a function, a three-item list, a
 * two-line poem and a link came to about 540 characters and was saved as a
 * "Document", the reply only saying "Done!". Tables are left out (like code,
 * they are structured content that belongs in the reply), as are markup and
 * link targets; the words of headings, list items and quotes still count, so a
 * long plan written as lists is still a document.
 */
export function markdownProse(content: string): string {
  const blocks = fencedBlocks(content);
  let text = content;
  // Last first, so earlier offsets stay valid.
  for (const block of [...blocks].reverse())
    text = text.slice(0, block.start) + text.slice(block.end);
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.includes('|') && TABLE_DELIMITER.test(lines[index + 1] ?? '')) {
      // The header, the delimiter and every row up to the first blank line.
      index++;
      while (index + 1 < lines.length && (lines[index + 1] ?? '').trim() !== '') index++;
      continue;
    }
    kept.push(
      line
        .replace(/^\s{0,3}(>\s?)+/, '')
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
        .replace(/^\s*([-*_]\s*){3,}$/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'),
    );
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/** Why this Markdown is not artifact-worthy by itself, or null if it is. */
export function markdownArtifactRefusal(content: string): string | null {
  const blocks = fencedBlocks(content);
  const proseLength = markdownProse(content).length;
  const codeLength = blocks.reduce((total, block) => total + block.content.trim().length, 0);
  if (codeLength > 0 && codeLength >= proseLength) return CODE_MARKDOWN_REFUSAL;
  if (proseLength < MIN_MARKDOWN_ARTIFACT_CHARS) return SHORT_MARKDOWN_REFUSAL;
  return null;
}

/**
 * The same floor under HTML artifacts (#313). With Markdown declined, Claude
 * Haiku 4.5 (thinking), asked for "a small table of three planets and their
 * moons", saved it as an HTML page instead ("Planets and Their Moons", a
 * styled table), and the reply only described it. A page whose visible text is
 * short and that does nothing a reply cannot (no script, form, control,
 * drawing, media or animation) is a short answer in other clothes, so it is
 * declined the same way and the model writes it in its reply as Markdown.
 * Visible text is measured without tags, the head, styles and scripts; table
 * text counts here, so a page with a long table is kept.
 */
export const MIN_HTML_ARTIFACT_CHARS = MIN_MARKDOWN_ARTIFACT_CHARS;

export const SHORT_HTML_REFUSAL = `${ARTIFACT_NOT_SAVED}: a short page such as a table, a list or a few paragraphs belongs in your reply, written in Markdown (a table as a Markdown table). Write it in your reply once (do not repeat it if you already have).`;

/**
 * What a reply cannot show: scripts, event handlers, forms and controls,
 * canvas and SVG drawing, images and media, embedded documents, disclosure
 * widgets and CSS animation.
 */
const MORE_THAN_TEXT =
  /<(script|form|input|button|select|textarea|canvas|svg|img|picture|video|audio|iframe|object|embed|details|dialog|math)\b|<[a-z][^>]*\s(on[a-z]+\s*=|contenteditable\b)|@keyframes\b/i;

/**
 * The text an HTML page shows (#313), roughly: without comments, the head
 * (title, styles), scripts, styles and templates, tags and markup. An element
 * still open (the content still being written) runs to the end.
 */
export function htmlVisibleText(content: string): string {
  return (
    content
      .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
      .replace(/<(head|title|style|script|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<[a-z!?/][^>]*(?:>|$)/gi, ' ')
      // An entity is one character on the page.
      .replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, '_')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Why this HTML is not artifact-worthy by itself, or null if it is. */
export function htmlArtifactRefusal(content: string): string | null {
  if (MORE_THAN_TEXT.test(content)) return null;
  return htmlVisibleText(content).length < MIN_HTML_ARTIFACT_CHARS ? SHORT_HTML_REFUSAL : null;
}

/**
 * Why an artifact of this kind, not asked for, belongs in the reply, or null
 * (#149, #313). Code has its own rule (#298: only when asked for); SVG and
 * Mermaid are pictures, which a reply cannot hold as text.
 */
export function artifactFloorRefusal(kind: string, content: string): string | null {
  if (kind === 'markdown') return markdownArtifactRefusal(content);
  if (kind === 'html') return htmlArtifactRefusal(content);
  return null;
}

/**
 * Whether a person's message asks for an artifact by name: then the floor
 * gives way, as the guidance's "unless the person asks for an artifact" does.
 */
export const asksForArtifact = (text: string) => /\bartifacts?\b/i.test(text);

import { fencedBlocks } from './artifacts.js';
import { ARTIFACT_NOT_SAVED } from './tools.js';

/**
 * A floor under Markdown artifacts (#149). The guidance and the tool's own
 * description say a Markdown artifact is for a long prose document the person
 * asked for, and that program code stays in the reply; the instance's default
 * model still saved a three-row table and a three-line function as two
 * "Document" artifacts, and wrote both in its reply too. So `create_artifact`
 * declines them unless the person asked for an artifact, and the model is told
 * to keep the content in its reply.
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
 * Whether a person's message asks for an artifact by name: then the floor
 * gives way, as the guidance's "unless the person asks for an artifact" does.
 */
export const asksForArtifact = (text: string) => /\bartifacts?\b/i.test(text);

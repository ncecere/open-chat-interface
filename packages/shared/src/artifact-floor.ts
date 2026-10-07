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

/** Why this Markdown is not artifact-worthy by itself, or null if it is. */
export function markdownArtifactRefusal(content: string): string | null {
  const blocks = fencedBlocks(content);
  let prose = content;
  // Last first, so earlier offsets stay valid.
  for (const block of [...blocks].reverse())
    prose = prose.slice(0, block.start) + prose.slice(block.end);
  const proseLength = prose.trim().length;
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

import {
  isDeclinedArtifactPart,
  isToolPart,
  markdownArtifactRefusal,
  toolIdOfPart,
} from '@oci/shared';
import type { UIMessage } from 'ai';

/**
 * Artifact attempts the person does not see (#201).
 *
 * The server declines a Markdown artifact that is short or mostly code (#149)
 * and tells the model to keep the content in its reply. The reply showed each
 * such call as a failed step ("3 steps failed", with the note to the model
 * word for word) and, while it was written, opened the artifact panel on a
 * document that was then "not saved". Nothing failed and the reply is right,
 * so a declined call is left out of the reply, and so is a Markdown document
 * while, as written so far, it would be declined: it appears once it is long
 * enough to be kept, or once it is saved (when the person asked for an
 * artifact, the floor gives way and a short one appears when saved).
 *
 * A short static HTML page is declined too (#313), but only once it is
 * declined is it left out: a page writes its head and styles first, so a page
 * that will be kept looks short for most of its writing, and holding it back
 * would delay every page's live preview (code not asked for is likewise
 * shown while written and left out once declined, #298).
 */
function mayBeDeclined(part: unknown): boolean {
  if (!isToolPart(part) || toolIdOfPart(part) !== 'create_artifact') return false;
  if (part.state !== 'input-streaming' && part.state !== 'input-available') return false;
  const input = (part.input ?? {}) as { kind?: unknown; content?: unknown };
  // Until its kind arrives (a few tokens after the title) the card shows that
  // something is being prepared; the panel waits for the kind (see the provider).
  if (input.kind !== 'markdown') return false;
  return markdownArtifactRefusal(typeof input.content === 'string' ? input.content : '') !== null;
}

/** A tool part the reply leaves out: declined, or a Markdown document that would be. */
export const isHiddenArtifactAttempt = (part: unknown) =>
  isDeclinedArtifactPart(part) || mayBeDeclined(part);

const shown = new WeakMap<UIMessage, UIMessage>();

/**
 * The reply as the person sees it: without hidden artifact attempts. The same
 * object when nothing is hidden, and the same copy for the same message, so
 * memoized rows still skip unchanged replies.
 */
export function shownReply(message: UIMessage): UIMessage {
  if (message.role !== 'assistant' || !message.parts.some(isHiddenArtifactAttempt)) return message;
  let copy = shown.get(message);
  if (!copy) {
    copy = { ...message, parts: message.parts.filter((part) => !isHiddenArtifactAttempt(part)) };
    shown.set(message, copy);
  }
  return copy;
}

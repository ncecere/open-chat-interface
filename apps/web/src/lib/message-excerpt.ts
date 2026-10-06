import { plainTextOfMarkdown } from '@oci/shared';

/**
 * A message's opening words as plain text ("Walk3 table: give me a small…"),
 * to tell its controls apart from every other message's (#194). Null when the
 * message has no text.
 */
export function messageExcerpt(text: string, max = 40): string | null {
  const plain = plainTextOfMarkdown(text).replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  // End at a word boundary when one is near.
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?·–—-]+$/, '')}…`;
}

/**
 * How a message's controls name it: its opening words, quoted, and its place
 * when it has one (see `repeatedOpeningPositions`): “Here is the plan…”, or
 * “Again.” (question 2).
 */
export function quotedMessage(excerpt: string, position?: string | null): string {
  return `“${excerpt}”${position ? ` (${position})` : ''}`;
}

const POSITION_NOUN: Record<string, string> = { user: 'question', assistant: 'reply' };

/**
 * Opening words are not enough when two messages share them (#293): replies
 * that open "Here is the short Python example…" or follow-ups like "Again."
 * or "Yes" gave every one the same "Copy message “Again.”" and "Code block 1
 * (Python) in “Here is…”". So a message whose opening words another message
 * in the conversation shares is also named by its place among the shown
 * messages of its kind: "reply 3", "question 2". Messages that open
 * differently keep the shorter name. Null for those, and for messages with
 * no text.
 */
export function repeatedOpeningPositions(
  messages: ReadonlyArray<{ role: string; excerpt: string | null }>,
): (string | null)[] {
  const seen = new Map<string, number>();
  for (const { excerpt } of messages) if (excerpt) seen.set(excerpt, (seen.get(excerpt) ?? 0) + 1);
  const counts = new Map<string, number>();
  return messages.map(({ role, excerpt }) => {
    const place = (counts.get(role) ?? 0) + 1;
    counts.set(role, place);
    if (!excerpt || (seen.get(excerpt) ?? 0) < 2) return null;
    return `${POSITION_NOUN[role] ?? 'message'} ${place}`;
  });
}

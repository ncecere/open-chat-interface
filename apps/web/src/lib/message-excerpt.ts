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

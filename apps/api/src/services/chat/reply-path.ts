import { isNull, schema } from '@oci/db';

/**
 * Retried replies. A user turn may have several stored assistant replies, of
 * which exactly one is active (`superseded_at` null). Model context, exports,
 * share links and search read only the active path; usage accounting still
 * counts every reply that was generated.
 *
 * Only the latest turn's reply can be retried or switched. Changing an earlier
 * turn would silently change what every later reply was answering, which is
 * what editing (a new conversation) is for.
 */

/** Rows on the active path. User messages are never superseded. */
export const activeMessage = () => isNull(schema.message.supersededAt);

export const RETRY_LATEST_ONLY =
  'Only the latest reply can be retried or switched. Edit an earlier message to start a new conversation from it.';

type PathRow = { id: string; role: string; supersededAt: Date | null };

/**
 * The conversation as it reads through `selectedId`, given rows in position
 * order: the active path, except that a selected superseded reply stands in
 * for its turn's active one. Null when the selection is not among the rows.
 */
export function pathThrough<T extends PathRow>(ordered: T[], selectedId: string): T[] | null {
  const index = ordered.findIndex((row) => row.id === selectedId);
  const selected = ordered[index];
  if (!selected) return null;
  if (selected.role !== 'assistant')
    return ordered.slice(0, index + 1).filter((row) => row.supersededAt === null);
  let prompt = index - 1;
  while (prompt >= 0 && ordered[prompt]!.role !== 'user') prompt--;
  return [...ordered.slice(0, prompt + 1).filter((row) => row.supersededAt === null), selected];
}

/**
 * Every reply to the latest user turn, oldest first, when there is more than
 * one; otherwise empty. Rows must be in position order.
 */
export function latestTurnReplies<T extends { role: string }>(ordered: T[]): T[] {
  let prompt = ordered.length - 1;
  while (prompt >= 0 && ordered[prompt]!.role !== 'user') prompt--;
  if (prompt < 0) return [];
  const replies = ordered.slice(prompt + 1).filter((row) => row.role === 'assistant');
  return replies.length > 1 ? replies : [];
}

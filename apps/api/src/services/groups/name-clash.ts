/**
 * Whether a database error is the unique-name violation of a group (`group_name_unique`), however
 * deeply it is wrapped: the driver's error may arrive as itself or as the `cause` of the query
 * library's error, depending on where the statement failed. Kept apart from the service so it can be
 * tested on every shape without a database.
 */
export function isNameClash(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === 'group_name_unique'
    ) {
      return true;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * LIKE/ILIKE patterns for text people type. `%` and `_` are wildcards and `\`
 * is the default escape character, so all three are escaped to match
 * literally: searching for "50%" finds "50%", not every "50".
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** Matches values containing `value` anywhere. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

/** Matches values starting with `value`. */
export function prefixPattern(value: string): string {
  return `${escapeLike(value)}%`;
}

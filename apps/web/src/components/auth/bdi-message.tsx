import type { ReactNode } from 'react';
import type { MessageKey, Translate } from '~/lib/i18n';

// Private-use characters that cannot be in a catalog message or in the text a
// person typed, so the split below finds only what it put there.
const OPEN = '\uE000';
const CLOSE = '\uE001';
const MARK = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');

/**
 * One translated sentence with text of the person's (an email address, a name
 * they gave something) inside it, each such value in its own `<bdi>` so that
 * the sentence is not reordered by it: an address in the middle of an Arabic
 * sentence stays one left-to-right run with its punctuation outside it.
 *
 * The sentence is still ONE catalog message with `{placeholders}`, so a
 * translation can move the value anywhere; the values go in as markers and are
 * swapped for elements after the message is filled in.
 */
export function bdiMessage(
  t: Translate,
  key: MessageKey,
  params: Record<string, string | number> | undefined,
  isolated: Record<string, string>,
): ReactNode[] {
  const values: string[] = [];
  const markers: Record<string, string> = {};
  for (const [name, value] of Object.entries(isolated)) {
    markers[name] = `${OPEN}${values.length}${CLOSE}`;
    values.push(value);
  }
  const text = t(key, { ...params, ...markers });
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MARK)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<bdi key={`value-${at}`}>{values[Number(match[1])]}</bdi>);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

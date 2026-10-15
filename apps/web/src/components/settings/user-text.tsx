import { Fragment, type ReactNode } from 'react';
import type { MessageKey, MessageParams, Translate } from '~/lib/i18n';

/**
 * A translated sentence with somebody's own text inside it (a conversation
 * title, a file name), the text wrapped in `<bdi>` so that a title in one
 * script cannot reorder the words around it in a sentence of the other (a
 * right-to-left title in an English sentence, an English file name in an
 * Arabic one).
 *
 * It is still one message with placeholders, so a language can put the text
 * wherever its word order wants it. `userKeys` names the placeholders that hold
 * user text; the others are filled in as usual.
 */
const START = '\u0001';
const END = '\u0002';

/**
 * A translated sentence with an element inside it (a link to a project, a
 * link to a conversation): `nodes` holds the elements by placeholder name. One
 * message, so a language can put the element anywhere. The element is
 * responsible for its own text direction (`dir="auto"` on a link to user text).
 */
export function tWithNodes(
  t: Translate,
  key: MessageKey,
  params: MessageParams,
  nodes: Record<string, ReactNode>,
): ReactNode {
  const marked: MessageParams = { ...params };
  for (const name of Object.keys(nodes)) marked[name] = `${START}${name}${END}`;
  const parts = t(key, marked).split(new RegExp(`${START}(\\w+)${END}`));
  return parts.map((part, index) => {
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed pieces of one message
    if (index % 2 === 0) return part === '' ? null : <Fragment key={index}>{part}</Fragment>;
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed pieces of one message
    return <Fragment key={index}>{nodes[part]}</Fragment>;
  });
}

export function tWithUserText(
  t: Translate,
  key: MessageKey,
  params: MessageParams,
  userKeys: readonly string[],
): ReactNode {
  const marked: MessageParams = { ...params };
  for (const name of userKeys) marked[name] = `${START}${name}${END}`;
  const message = t(key, marked);
  const parts = message.split(new RegExp(`${START}(\\w+)${END}`));
  // The pieces of one message, in a fixed order: an index is the right key.
  return parts.map((part, index) => {
    // Split with one capture group: odd entries are placeholder names.
    if (index % 2 === 0) {
      // biome-ignore lint/suspicious/noArrayIndexKey: fixed pieces of one message
      return part === '' ? null : <Fragment key={index}>{part}</Fragment>;
    }
    // biome-ignore lint/suspicious/noArrayIndexKey: fixed pieces of one message
    return <bdi key={index}>{String(params[part] ?? '')}</bdi>;
  });
}

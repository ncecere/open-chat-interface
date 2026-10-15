import { Fragment, type ReactNode } from 'react';
import type { MessageKey, MessageParams, Translate } from '~/lib/i18n';

// Marks where a node goes in the translated text. Not a character a catalog
// message contains, and never shown: the text is cut at it.
const MARK = '\u0001';
const SLOT = new RegExp(`${MARK}([A-Za-z0-9_]+)${MARK}`);

/**
 * A translated sentence with elements inside it: `t()` returns text, so a
 * `<bdi>` around a title or a `<strong>` around a name cannot be put in the
 * message. Give the element as `nodes.title` and write `{title}` in the
 * message; the translator keeps the word order, the element goes where the
 * placeholder is. `params` are the plain placeholders (numbers, class names).
 */
export function translatedNodes(
  t: Translate,
  key: MessageKey,
  nodes: Record<string, ReactNode>,
  params: MessageParams = {},
): ReactNode {
  const slots = Object.fromEntries(
    Object.keys(nodes).map((name) => [name, `${MARK}${name}${MARK}`]),
  );
  const parts = t(key, { ...params, ...slots }).split(SLOT);
  // Even indexes are text, odd ones the name of a slot.
  return parts.map((part, index) => {
    const key = `${index}-${part}`;
    return index % 2 === 0 ? (
      <Fragment key={key}>{part}</Fragment>
    ) : (
      <Fragment key={key}>{nodes[part]}</Fragment>
    );
  });
}

/** A piece of user text inside a sentence, isolated so it cannot reorder what is around it. */
export function Isolated({ children }: { children: ReactNode }) {
  return <bdi>{children}</bdi>;
}

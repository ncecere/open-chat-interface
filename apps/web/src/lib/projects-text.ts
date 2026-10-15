import { getI18nState } from '~/lib/i18n';

const FIRST_STRONG_ISOLATE = '\u2068';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

/**
 * Text a person wrote (a project's name, a person's name, a file name) placed
 * inside a translated sentence that is built as one string, such as a dialog
 * title, a toast or an `aria-label`, where a `<bdi>` element cannot go.
 *
 * In a right-to-left language the name is wrapped in a first-strong isolate
 * (what `<bdi>` does), so a Latin name does not pull the neighbouring Arabic
 * words, or the quotation marks around it, out of order. Left to right it is
 * returned as it is: nothing there can be reordered, and the text stays plain.
 */
export function isolate(text: string): string {
  if (getI18nState().dir !== 'rtl') return text;
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

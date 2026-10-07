/**
 * Each paragraph takes its own direction (#360). Markdown from a reply or a
 * person's own message has no direction of its own, so Arabic and Hebrew text
 * was laid out left to right and aligned left: sentences started at the wrong
 * side, list numbers sat on the wrong side, and a full stop or a number at the
 * end of a sentence landed at the wrong end of it.
 *
 * Blocks that hold text directly (paragraphs, headings, list items, table
 * cells) get `dir="auto"`: the browser reads the block's first strong letter,
 * so an Arabic paragraph and an English one in the same reply each follow their
 * own script. Lists and quotes hold other blocks, and `dir="auto"` skips
 * children that have a direction of their own, so a list of Arabic items
 * would stay left to right and its numbers would fall outside it. They get the
 * direction of their first strong letter instead, and so indent, number and
 * draw their bar on the right side. Code blocks, inline code and maths are not
 * touched: code stays left to right (see the prose classes in markdown.tsx).
 */

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const LEAF_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'th', 'td']);
const CONTAINERS = new Set(['ul', 'ol', 'blockquote']);

/** Letters of right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, N'Ko and their forms. */
const RIGHT_TO_LEFT_LETTER =
  /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u0780-\u07bf\u07c0-\u07ff\u0800-\u083f\u0840-\u085f\u0860-\u086f\u0870-\u089f\u08a0-\u08ff\ufb1d-\ufb4f\ufb50-\ufdff\ufe70-\ufeff]/u;

/** The direction of the first letter in `text` that has one; null when there is none. */
export function firstStrongDirection(text: string): 'ltr' | 'rtl' | null {
  for (const character of text) {
    if (RIGHT_TO_LEFT_LETTER.test(character)) return 'rtl';
    if (/\p{L}/u.test(character)) return 'ltr';
  }
  return null;
}

/** The words of a node in reading order, without code (which stays left to right). */
function words(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type !== 'element' && node.type !== 'root') return '';
  if (node.tagName === 'code' || node.tagName === 'pre') return '';
  return (node.children ?? []).map(words).join('');
}

function mark(node: HastNode): void {
  if (node.type === 'element' && node.tagName) {
    if (LEAF_BLOCKS.has(node.tagName)) {
      // A direction the Markdown itself carried (raw HTML) is the author's.
      node.properties = { dir: 'auto', ...node.properties };
    } else if (CONTAINERS.has(node.tagName)) {
      const direction = firstStrongDirection(words(node));
      if (direction) node.properties = { dir: direction, ...node.properties };
    }
  }
  for (const child of node.children ?? []) mark(child);
}

/** A rehype plugin: each block that holds text takes its own direction. */
export function rehypeAutoDirection() {
  return (tree: HastNode) => mark(tree);
}

import { quotedMessage } from '~/lib/message-excerpt';

/**
 * Names for the controls Streamdown puts on every code block, diagram and
 * table (#194). Streamdown names its buttons by `title` only, the same for
 * every block ("Download file", "Copy Code", "Copy table", "View
 * fullscreen"), and our scroll regions were all "Code block" or "Table", so a
 * screen-reader or voice user heard four identical sets in one reply. As the
 * admin pages do (#175), each name now says what it acts on: the block's
 * number within its message and, for code, its language ("Copy code block 2
 * (Python)", "Download table 1", "View diagram 1 full screen"). The visible
 * tooltip's words stay at the start of the name where they can.
 *
 * Numbers restart in every message, so a conversation of two replies with a
 * Python block each had two "Copy code block 1 (Python)" (#271). A block in a
 * message also names the message by its opening words, as the message's own
 * controls do: "Copy code block 1 (Python) in “Quick example…”". When
 * another message opens with the same words, its place too (#293): "… in
 * “Here is the short Python example you…” (reply 3)".
 *
 * Streamdown offers no prop for per-block names, so this runs on the rendered
 * DOM, with the scroll-region pass that already watches it. Names are set
 * again on every pass, so a block added above another renumbers both.
 */

/** Common languages as people write them; others show as written. */
const LANGUAGE_NAMES: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  cs: 'C#',
  css: 'CSS',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  md: 'Markdown',
  php: 'PHP',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  py: 'Python',
  python: 'Python',
  r: 'R',
  rb: 'Ruby',
  ruby: 'Ruby',
  rust: 'Rust',
  rs: 'Rust',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Zsh',
};

export function languageName(language: string): string | null {
  const id = language.trim().toLowerCase();
  if (!id || id === 'text' || id === 'plaintext' || id === 'txt') return null;
  return LANGUAGE_NAMES[id] ?? language.trim();
}

/** Where blocks are numbered: one message, a dialog (the table's full-screen view), or the page. */
const scopeOf = (element: Element): ParentNode =>
  element.closest('article, [role="dialog"]') ?? element.ownerDocument;

function label(element: Element | null | undefined, name: string) {
  if (element && element.getAttribute('aria-label') !== name)
    element.setAttribute('aria-label', name);
}

/**
 * Which message the scope is: ` in “Quick example…”`, from its opening words,
 * and ` in “Again.” (reply 3)` when another message shares them.
 */
function inMessage(scope: ParentNode): string {
  if (!(scope instanceof Element)) return '';
  const excerpt = scope.getAttribute('data-excerpt');
  return excerpt ? ` in ${quotedMessage(excerpt, scope.getAttribute('data-position'))}` : '';
}

/** A block's buttons, told apart by the tooltip Streamdown gives each. */
function buttonTitled(block: Element, ...titles: string[]): Element | undefined {
  return [...block.querySelectorAll('button[title]')].find((button) =>
    titles.includes(button.getAttribute('title') ?? ''),
  );
}

/** The blocks numbered in this scope, not those of a message inside it. */
const blocksOf = (scope: ParentNode, kind: string) =>
  [...scope.querySelectorAll(`[data-streamdown="${kind}"]`)].filter(
    (block) => scopeOf(block) === scope,
  );

function nameCodeBlocks(scope: ParentNode) {
  const where = inMessage(scope);
  blocksOf(scope, 'code-block').forEach((block, index) => {
    const language = languageName(block.getAttribute('data-language') ?? '');
    const which = `${index + 1}${language ? ` (${language})` : ''}${where}`;
    const name = `code block ${which}`;
    label(block.querySelector('[data-streamdown="code-block-body"]'), `Code block ${which}`);
    label(block.querySelector('[data-streamdown="code-block-copy-button"]'), `Copy ${name}`);
    label(
      block.querySelector('[data-streamdown="code-block-download-button"]'),
      `Download ${name}`,
    );
  });
}

function nameDiagrams(scope: ParentNode) {
  const where = inMessage(scope);
  blocksOf(scope, 'mermaid-block').forEach((diagram, index) => {
    const name = `diagram ${index + 1}`;
    label(
      diagram.querySelector('[data-streamdown="code-block-copy-button"]'),
      `Copy ${name} code${where}`,
    );
    label(buttonTitled(diagram, 'Download diagram'), `Download ${name}${where}`);
    label(buttonTitled(diagram, 'View fullscreen'), `View ${name} full screen${where}`);
  });
}

function nameTables(scope: ParentNode) {
  const where = inMessage(scope);
  blocksOf(scope, 'table-wrapper').forEach((table, index) => {
    const name = `table ${index + 1}`;
    label(table.querySelector(':scope > .overflow-x-auto'), `Table ${index + 1}${where}`);
    label(buttonTitled(table, 'Copy table'), `Copy ${name}${where}`);
    label(buttonTitled(table, 'Download table'), `Download ${name}${where}`);
    label(buttonTitled(table, 'View fullscreen'), `View ${name} full screen${where}`);
  });
}

/**
 * The table's full-screen view (#246). Streamdown portals it to the body, out
 * of the table it shows, and names its toolbar by `title` only ("Copy table",
 * "Download table", "Exit fullscreen"). Its controls are named for the table
 * that opened it, as that table's own are, and Exit says "full screen" as
 * the button that opened it does.
 */
export function nameTableFullscreen(overlay: Element, opener: Element | null): void {
  // "View table 2 full screen", and the message it is in (#271, #293).
  const [, which, where = ''] =
    opener?.getAttribute('aria-label')?.match(/^View table (\d+) full screen( in “.*)?$/) ?? [];
  const name = which ? `table ${which}` : 'table';
  label(overlay, `${which ? `Table ${which}` : 'Table'}${where}, full screen`);
  label(buttonTitled(overlay, 'Copy table'), `Copy ${name}${where}`);
  label(buttonTitled(overlay, 'Download table'), `Download ${name}${where}`);
  label(buttonTitled(overlay, 'Exit fullscreen'), 'Exit full screen');
}

/** Names every Streamdown block control under `root`, numbered within its message. */
export function nameStreamdownControls(root: ParentNode = document): void {
  const scopes = new Set<ParentNode>();
  for (const block of root.querySelectorAll(
    '[data-streamdown="code-block"], [data-streamdown="mermaid-block"], [data-streamdown="table-wrapper"]',
  ))
    scopes.add(scopeOf(block));
  for (const scope of scopes) {
    nameCodeBlocks(scope);
    nameDiagrams(scope);
    nameTables(scope);
  }
}

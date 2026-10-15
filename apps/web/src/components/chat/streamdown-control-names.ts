import { streamdownTitle } from '~/components/chat/streamdown-translations';
import { formatNumber, type MessageKey, translate } from '~/lib/i18n';
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
 * A control's name. Each name is a whole message, with a second one that also
 * says which message it is in, so a language can order the words as it needs
 * (`key` and `keyInMessage` in the catalog).
 */
function named(key: NamedKey, params: Record<string, string>, message: string | null): string {
  return message
    ? translate(`${key}InMessage` as MessageKey, { ...params, message })
    : translate(key as MessageKey, params);
}

type NamedKey =
  | 'chat.controls.codeBlock'
  | 'chat.controls.codeCopy'
  | 'chat.controls.codeDownload'
  | 'chat.controls.diagramCopy'
  | 'chat.controls.diagramDownload'
  | 'chat.controls.diagramView'
  | 'chat.controls.tableRegion'
  | 'chat.controls.tableCopy'
  | 'chat.controls.tableDownload'
  | 'chat.controls.tableView'
  | 'chat.controls.tableFullScreen';

/**
 * Which message the scope is, from its opening words (“Quick example…”), and
 * its place when another message shares them (“Again.” (reply 3)). Null when
 * the scope is not a message.
 */
function inMessage(scope: ParentNode): string | null {
  if (!(scope instanceof Element)) return null;
  const excerpt = scope.getAttribute('data-excerpt');
  return excerpt ? quotedMessage(excerpt, scope.getAttribute('data-position')) : null;
}

/** A block's buttons, told apart by the tooltip Streamdown gives each (in the language shown). */
function buttonTitled(
  block: Element,
  ...titles: Parameters<typeof streamdownTitle>[0][]
): Element | undefined {
  const wanted = titles.map(streamdownTitle);
  return [...block.querySelectorAll('button[title]')].find((button) =>
    wanted.includes(button.getAttribute('title') ?? ''),
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
    const number = formatNumber(index + 1);
    const which = language
      ? translate('chat.controls.numberLanguage', { n: number, language })
      : number;
    const params = { which };
    label(
      block.querySelector('[data-streamdown="code-block-body"]'),
      named('chat.controls.codeBlock', params, where),
    );
    label(
      block.querySelector('[data-streamdown="code-block-copy-button"]'),
      named('chat.controls.codeCopy', params, where),
    );
    label(
      block.querySelector('[data-streamdown="code-block-download-button"]'),
      named('chat.controls.codeDownload', params, where),
    );
  });
}

function nameDiagrams(scope: ParentNode) {
  const where = inMessage(scope);
  blocksOf(scope, 'mermaid-block').forEach((diagram, index) => {
    const params = { n: formatNumber(index + 1) };
    label(
      diagram.querySelector('[data-streamdown="code-block-copy-button"]'),
      named('chat.controls.diagramCopy', params, where),
    );
    label(
      buttonTitled(diagram, 'downloadDiagram'),
      named('chat.controls.diagramDownload', params, where),
    );
    label(
      buttonTitled(diagram, 'viewFullscreen'),
      named('chat.controls.diagramView', params, where),
    );
  });
}

function nameTables(scope: ParentNode) {
  const where = inMessage(scope);
  blocksOf(scope, 'table-wrapper').forEach((table, index) => {
    const params = { n: formatNumber(index + 1) };
    label(
      table.querySelector(':scope > .overflow-x-auto'),
      named('chat.controls.tableRegion', params, where),
    );
    label(buttonTitled(table, 'copyTable'), named('chat.controls.tableCopy', params, where));
    label(
      buttonTitled(table, 'downloadTable'),
      named('chat.controls.tableDownload', params, where),
    );
    label(buttonTitled(table, 'viewFullscreen'), named('chat.controls.tableView', params, where));
  });
}

/**
 * Reads a name made by `named` back into its parts: the message is turned
 * into a pattern with a capture where each placeholder goes, so it works in
 * any language.
 */
// Marks where a placeholder went when a name is read back; not a character a message contains.
const MARK = '\u0001';
const SLOT = new RegExp(`${MARK}(\\w+)${MARK}`);

function parseName(
  text: string,
  key: MessageKey,
  names: readonly string[],
): Record<string, string> | null {
  const marks = Object.fromEntries(names.map((name) => [name, `${MARK}${name}${MARK}`]));
  const parts = translate(key, marks).split(SLOT);
  const order: string[] = [];
  const pattern = parts
    .map((part, index) => {
      if (index % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      order.push(part);
      return part === 'n' ? '(\\S+?)' : '(.+)';
    })
    .join('');
  const match = new RegExp(`^${pattern}$`).exec(text);
  if (!match) return null;
  return Object.fromEntries(order.map((name, index) => [name, match[index + 1] ?? '']));
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
  const text = opener?.getAttribute('aria-label') ?? '';
  const found =
    parseName(text, 'chat.controls.tableViewInMessage', ['n', 'message']) ??
    parseName(text, 'chat.controls.tableView', ['n']);
  if (found) {
    const params = { n: found.n ?? '' };
    const where = found.message ?? null;
    label(overlay, named('chat.controls.tableFullScreen', params, where));
    label(buttonTitled(overlay, 'copyTable'), named('chat.controls.tableCopy', params, where));
    label(
      buttonTitled(overlay, 'downloadTable'),
      named('chat.controls.tableDownload', params, where),
    );
  } else {
    label(overlay, translate('chat.controls.tablePlainFullScreen'));
    label(buttonTitled(overlay, 'copyTable'), translate('chat.controls.tablePlainCopy'));
    label(buttonTitled(overlay, 'downloadTable'), translate('chat.controls.tablePlainDownload'));
  }
  label(buttonTitled(overlay, 'exitFullscreen'), translate('chat.controls.exitFullScreen'));
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

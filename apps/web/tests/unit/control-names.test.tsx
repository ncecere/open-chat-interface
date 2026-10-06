// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import {
  installStreamdownScrollRegions,
  uninstallStreamdownScrollRegions,
} from '../../src/components/chat/streamdown-overlay-focus';

/**
 * Repeated controls in a conversation can be told apart (#194): each code
 * block's, table's and message's controls are named for what they act on.
 * The real list, rows and lazily loaded Streamdown renderer.
 */
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  uninstallStreamdownScrollRegions();
  document.body.innerHTML = '';
});

const message = (id: string, role: UIMessage['role'], text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  metadata: { status: 'complete', createdAt: '2026-10-05T12:00:00.000Z' },
});

const MESSAGES = [
  message('q1', 'user', 'Walk3 table: give me a small Markdown table of the three primary colours'),
  message(
    'a1',
    'assistant',
    '```python\na = 1\n```\n\n```python\nb = 2\n```\n\n| Colour | Example |\n| - | - |\n| Red | Apple |\n\n```\nplain\n```',
  ),
  message('q2', 'user', 'Now in **bash** please'),
  message('a2', 'assistant', '```bash\necho hi\n```'),
];

/** The first reply's opening words, as its own controls name it. */
const IN_A1 = ' in “a = 1 b = 2 Colour · Example Red…”';

const names = (scope: ParentNode, selector: string) =>
  [...scope.querySelectorAll(selector)].map((element) => element.getAttribute('aria-label'));

it('names each code block, table and message control for what it acts on', async () => {
  await act(async () =>
    root.render(
      <MessageList
        messages={MESSAGES}
        streaming={false}
        threadId="thread-1"
        onFork={async () => {}}
        onEdit={async () => {}}
      />,
    ),
  );
  await vi.waitFor(
    () => {
      expect(names(container, '[data-streamdown="code-block-body"]')).toHaveLength(4);
      expect(
        names(container, '[data-streamdown="code-block-body"]').every((name) =>
          name?.startsWith('Code block '),
        ),
      ).toBe(true);
    },
    { timeout: 5_000 },
  );

  const [reply, next] = [...container.querySelectorAll('[data-message-id^="a"]')];
  expect(names(reply!, '[data-streamdown="code-block-body"]')).toEqual([
    `Code block 1 (Python)${IN_A1}`,
    `Code block 2 (Python)${IN_A1}`,
    `Code block 3${IN_A1}`,
  ]);
  expect(names(reply!, '[data-streamdown="code-block"] button')).toEqual([
    `Download code block 1 (Python)${IN_A1}`,
    `Copy code block 1 (Python)${IN_A1}`,
    `Download code block 2 (Python)${IN_A1}`,
    `Copy code block 2 (Python)${IN_A1}`,
    `Download code block 3${IN_A1}`,
    `Copy code block 3${IN_A1}`,
  ]);
  expect(names(reply!, '[data-streamdown="table-wrapper"] button')).toEqual([
    `Copy table 1${IN_A1}`,
    `Download table 1${IN_A1}`,
    `View table 1 full screen${IN_A1}`,
  ]);
  expect(names(reply!, '[data-streamdown="table-wrapper"] [role="region"]')).toEqual([
    `Table 1${IN_A1}`,
  ]);
  // Numbered within each message, which is named as its own controls name it (#271).
  expect(names(next!, '[data-streamdown="code-block"] button')).toEqual([
    'Download code block 1 (Bash) in “echo hi”',
    'Copy code block 1 (Bash) in “echo hi”',
  ]);
  // The tooltip is in sentence case like every other control.
  expect(
    reply!.querySelector('[data-streamdown="code-block-copy-button"]')?.getAttribute('title'),
  ).toBe('Copy code');

  // Each message's own controls name it by its opening words.
  const messageControls = names(container, 'article > div:last-child button[aria-label]');
  expect(messageControls).toEqual(
    expect.arrayContaining([
      'Copy message “Walk3 table: give me a small Markdown…”',
      'Fork conversation at “Walk3 table: give me a small Markdown…”',
      'Edit message “Walk3 table: give me a small Markdown…”',
      'Copy message “Now in bash please”',
      'Edit message “Now in bash please”',
      'Copy message “a = 1 b = 2 Colour · Example Red…”',
      'Copy message “echo hi”',
      'Export as… “echo hi”',
    ]),
  );
  // No two buttons in the conversation share a name.
  const all = names(container, 'button[aria-label]');
  expect(new Set(all).size).toBe(all.length);
});

/**
 * #271: two replies with the same kinds of block, as the QA walk asked for:
 * each began with "###" and held a Python block and a table. Numbering
 * restarted in each, so the page had two "Code block 1 (Python)" regions,
 * two "Table 1" and two of each button; and "###" became an h4 under the h1.
 */
it('names the blocks of several replies apart, and their headings follow the page h1', async () => {
  const reply = (title: string) =>
    `### ${title}\n\n\`\`\`python\nprint(1)\n\`\`\`\n\n| A | B |\n| - | - |\n| 1 | 2 |`;
  // The renderer installs this once, when it loads; the previous test removed it.
  installStreamdownScrollRegions();
  await act(async () =>
    root.render(
      <MessageList
        messages={[
          message('q1', 'user', 'Show me a loop'),
          message('a1', 'assistant', reply('Quick example')),
          message('q2', 'user', 'And a function'),
          message('a2', 'assistant', reply('A function')),
        ]}
        streaming={false}
        threadId="thread-1"
      />,
    ),
  );
  await vi.waitFor(
    () =>
      expect(
        names(container, '[role="region"]').filter((name) => name?.startsWith('Table 1')),
      ).toHaveLength(2),
    { timeout: 5_000 },
  );

  const regions = names(container, '[role="region"]');
  expect(regions).toEqual([
    'Code block 1 (Python) in “Quick example print(1) A · B 1 · 2”',
    'Table 1 in “Quick example print(1) A · B 1 · 2”',
    'Code block 1 (Python) in “A function print(1) A · B 1 · 2”',
    'Table 1 in “A function print(1) A · B 1 · 2”',
  ]);
  const buttons = names(container, 'button[aria-label]');
  expect(buttons).toContain('Copy code block 1 (Python) in “A function print(1) A · B 1 · 2”');
  expect(new Set(buttons).size).toBe(buttons.length);

  // Under the conversation's h1, each reply's "###" is an h2, not an h4.
  const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  expect(headings.map((heading) => `${heading.tagName} ${heading.textContent}`)).toEqual([
    'H2 Quick example',
    'H2 A function',
  ]);
});

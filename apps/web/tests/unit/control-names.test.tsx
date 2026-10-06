// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';
import { uninstallStreamdownScrollRegions } from '../../src/components/chat/streamdown-overlay-focus';

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
    'Code block 1 (Python)',
    'Code block 2 (Python)',
    'Code block 3',
  ]);
  expect(names(reply!, '[data-streamdown="code-block"] button')).toEqual([
    'Download code block 1 (Python)',
    'Copy code block 1 (Python)',
    'Download code block 2 (Python)',
    'Copy code block 2 (Python)',
    'Download code block 3',
    'Copy code block 3',
  ]);
  expect(names(reply!, '[data-streamdown="table-wrapper"] button')).toEqual([
    'Copy table 1',
    'Download table 1',
    'View table 1 full screen',
  ]);
  expect(names(reply!, '[data-streamdown="table-wrapper"] [role="region"]')).toEqual(['Table 1']);
  // Numbered within each message.
  expect(names(next!, '[data-streamdown="code-block"] button')).toEqual([
    'Download code block 1 (Bash)',
    'Copy code block 1 (Bash)',
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
      'Copy message “echo hi”',
      'Export as… “echo hi”',
    ]),
  );
  // No two buttons in the conversation share a name.
  const all = names(container, 'button[aria-label]');
  expect(new Set(all).size).toBe(all.length);
});

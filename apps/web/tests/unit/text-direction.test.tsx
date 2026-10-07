// @vitest-environment happy-dom
import type { CatalogModel, ThreadSearchResult } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import { Markdown } from '../../src/components/chat/markdown';
import { firstStrongDirection } from '../../src/components/chat/markdown-direction';
import { SearchResultContent } from '../../src/components/layout/thread-search-results';
import { ThemeProvider } from '../../src/providers/theme-provider';

/**
 * Right-to-left text (#360): each paragraph, list, item and table cell takes
 * its own direction from its first strong letter (`dir="auto"`, resolved by
 * the browser), through the real lazily loaded Streamdown renderer. Code stays
 * out of it.
 */
vi.mock('../../src/components/chat/composer-connect-hint', () => ({
  ComposerConnectHint: () => null,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

async function render(markdown: string, math?: boolean) {
  await act(async () => root.render(<Markdown math={math}>{markdown}</Markdown>));
  await vi.waitFor(() => expect(container.querySelector('p, table, pre, li')).not.toBeNull(), {
    timeout: 5_000,
  });
}

const REPLY = [
  'اكتب لي جملتين عن المكتبة.',
  '',
  '1. المكتبة مكان للقراءة.',
  '2. فيها كتب كثيرة: 12',
  '',
  '- English item',
  '',
  'An English paragraph.',
  '',
  '> اقتباس عربي',
  '',
  '## عنوان',
  '',
  '| الاسم | القيمة |',
  '| - | - |',
  '| جملة عربية تنتهي برقم 12 | text |',
  '',
  '```js',
  'const مكتبة = 1;',
  '```',
  '',
  'نص مع `code` داخل السطر.',
].join('\n');

describe('a reply with right-to-left text', () => {
  it('lets every paragraph, list, item, quote, heading and table cell take its own direction', async () => {
    await render(REPLY);
    const marked = (selector: string) =>
      [...container.querySelectorAll(selector)].map((element) => element.getAttribute('dir'));
    expect(marked('p')).not.toContain(null);
    expect(marked('p').length).toBeGreaterThanOrEqual(3);
    for (const selector of ['li', 'th', 'td', 'h2, h3']) {
      const found = marked(selector);
      expect(found.length, selector).toBeGreaterThan(0);
      expect(new Set(found), selector).toEqual(new Set(['auto']));
    }
    // Lists and quotes hold other blocks, which auto would skip: each takes the
    // direction of its first letter, so the Arabic list and quote are right to left
    // and the English list is not.
    expect(marked('ol')).toEqual(['rtl']);
    expect(marked('ul')).toEqual(['ltr']);
    expect(marked('blockquote')).toEqual(['rtl']);
    // Two Arabic items and an English one, each its own.
    expect(container.querySelectorAll('li[dir="auto"]')).toHaveLength(3);
  });

  it('leaves code blocks and inline code alone', async () => {
    await render(REPLY);
    const block = container.querySelector('[data-streamdown="code-block"]')!;
    expect(block).not.toBeNull();
    expect(block.hasAttribute('dir')).toBe(false);
    expect(block.querySelector('[dir]')).toBeNull();
    expect(container.querySelector('pre')?.closest('[dir]')).toBeNull();
    expect(container.querySelector('code')?.hasAttribute('dir')).toBe(false);
  });

  it('applies to a person’s own message too (maths off) and to a share page’s (safe-link policy)', async () => {
    await render('اكتب لي جملتين.\n\n1. أول\n2. ثان', false);
    expect(container.querySelector('p')?.getAttribute('dir')).toBe('auto');
    expect(container.querySelectorAll('li[dir="auto"]')).toHaveLength(2);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Markdown skipHtml urlTransform={() => null}>
          {'جملة عربية.'}
        </Markdown>,
      ),
    );
    await vi.waitFor(() => expect(container.querySelector('p')).not.toBeNull());
    expect(container.querySelector('p')?.getAttribute('dir')).toBe('auto');
  });

  it('keeps a direction written in the Markdown’s own HTML', async () => {
    await render('<p dir="ltr">مرحبا</p>');
    expect(container.querySelector('p')?.getAttribute('dir')).toBe('ltr');
  });
});

describe('a conversation search result', () => {
  const result: ThreadSearchResult = {
    thread: {
      id: 't1',
      title: 'واجب الكتابة',
      archived: false,
    } as ThreadSearchResult['thread'],
    rank: 1,
    titleHighlight: 'واجب الكتابة',
    matches: [{ messageId: 'm1', role: 'assistant', snippet: 'اكتب لي جملتين عن المكتبة' }],
  };

  it('reads its title and its snippet by their own letters, not the English label', async () => {
    await act(async () => root.render(<SearchResultContent result={result} />));
    const spans = [...container.querySelectorAll('span[dir]')];
    const title = spans.find((span) => span.textContent === 'واجب الكتابة');
    expect(title?.getAttribute('dir')).toBe('auto');
    const snippet = container.querySelector('span.line-clamp-2');
    expect(snippet?.getAttribute('dir')).toBe('auto');
    // "Reply: " is its own left-to-right run, skipped when the direction is chosen.
    expect(snippet?.querySelector('span[dir="ltr"]')?.textContent).toBe('Reply: ');
  });
});

describe('the message box', () => {
  const model: CatalogModel = {
    id: 'm',
    slug: 'm',
    displayName: 'Model',
    description: null,
    providerId: 'p',
    providerKind: 'openai-compatible',
    providerLabel: 'P',
    upstreamModelId: 'm',
    capabilities: [],
    labId: 'openai',
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    isDefault: false,
    sortOrder: 0,
  };

  it('follows the direction of what is typed', async () => {
    await act(async () =>
      root.render(
        <ThemeProvider>
          <Composer
            value="اكتب لي جملتين"
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            onStop={vi.fn()}
            models={[model]}
            selectedModel={model}
            onSelectModel={vi.fn()}
            effort="low"
            onEffortChange={vi.fn()}
            webSearch={false}
            onWebSearchChange={vi.fn()}
            onAttachFiles={vi.fn()}
          />
        </ThemeProvider>,
      ),
    );
    const box = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message input"]',
    );
    expect(box?.getAttribute('dir')).toBe('auto');
  });
});

describe('the direction of a first letter', () => {
  it.each([
    ['اكتب لي جملتين', 'rtl'],
    ['שלום עולם', 'rtl'],
    ['سلام، دنیا', 'rtl'],
    ['میں ٹھیک ہوں', 'rtl'],
    ['Hello مرحبا', 'ltr'],
    ['日本語', 'ltr'],
    ['Привет', 'ltr'],
    // Digits, punctuation and spaces have no direction of their own: the first letter decides.
    ['12. مرحبا', 'rtl'],
    ['  (12) hello', 'ltr'],
    ['123 — 456', null],
    ['', null],
  ])('%j reads %s', (text, direction) => {
    expect(firstStrongDirection(text)).toBe(direction);
  });
});

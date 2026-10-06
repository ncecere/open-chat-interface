import { expect, type Page, test } from '@playwright/test';

/**
 * A public share's reply measured in a real browser: line structure, colours
 * and overflow come from CSS a unit test cannot see. The share is served from
 * a fixture, so the spec needs no conversation on the instance.
 */
const SLUG = 'fix3-share-rendering';

const REPLY = [
  'Here is the script:',
  '',
  '```bash',
  '#!/bin/bash',
  '# Back up the research data',
  'tar -czf backup.tgz /data',
  'echo "done"',
  '```',
  '',
  'And the function:',
  '',
  '```python',
  'def reverse(text):',
  '    return text[::-1]',
  '```',
  '',
  'Use `reverse()` inline.',
].join('\n');

async function openShare(page: Page, text: string) {
  await page.route(`**/api/share-links/${SLUG}`, (route) =>
    route.fulfill({
      json: {
        thread: { title: 'Fix3 share rendering', sharedAt: '2026-10-05T12:00:00.000Z' },
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [
              { type: 'text', text: 'Why does this fail?\n\n```js\nconst a = 1;\na = 2;\n```' },
            ],
            createdAt: '2026-10-05T12:00:00.000Z',
          },
          {
            id: 'a1',
            role: 'assistant',
            parts: [{ type: 'text', text }],
            createdAt: '2026-10-05T12:00:01.000Z',
          },
        ],
        artifacts: [],
        snapshot: true,
        expiresAt: null,
      },
    }),
  );
  await page.goto(`/share/${SLUG}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Fix3 share rendering' })).toBeVisible();
}

test('a shared reply keeps its code blocks multi-line and highlighted (#186)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShare(page, REPLY);
  const reply = page.getByRole('article', { name: /Assistant message/ });
  const bash = reply.locator('[data-streamdown="code-block-body"][data-language="bash"] pre');
  // Highlighted: Shiki has coloured the tokens (the plain first pass has no dark colours).
  await expect(bash.locator('code span[style*="--shiki-dark"]').first()).toBeAttached();

  const measured = await reply
    .locator('[data-streamdown="code-block-body"] pre')
    .evaluateAll((pres) =>
      pres.map((pre) => {
        const code = pre.querySelector('code') as HTMLElement;
        return {
          height: pre.getBoundingClientRect().height,
          text: (pre as HTMLElement).innerText,
          codePadding: getComputedStyle(code).paddingLeft,
          lineDisplay: getComputedStyle(code.firstElementChild as Element).display,
        };
      }),
    );
  expect(measured).toHaveLength(2);
  const [script, fn] = measured;
  // One row per line, as in the owner's view, not one 22 px row.
  expect(script?.text.trim().split('\n')).toEqual([
    '#!/bin/bash',
    '# Back up the research data',
    'tar -czf backup.tgz /data',
    'echo "done"',
  ]);
  expect(script?.height).toBeGreaterThan(60);
  expect(fn?.text.trim().split('\n')).toHaveLength(2);
  for (const block of measured) {
    expect(block.lineDisplay).toBe('block');
    // Not in the inline-code "pill".
    expect(block.codePadding).toBe('0px');
  }
  // Colours differ between tokens (a keyword and plain text).
  const colours = await bash
    .locator('code span span')
    .evaluateAll((spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size);
  expect(colours).toBeGreaterThan(1);

  // Code in the person's own message keeps its lines too.
  const asked = page.getByRole('article', { name: 'User message' }).locator('pre');
  expect((await asked.innerText()).trim().split('\n')).toEqual(['const a = 1;', 'a = 2;']);

  // Inline code keeps its pill.
  const inline = reply.locator('p code', { hasText: 'reverse()' });
  expect(await inline.evaluate((code) => getComputedStyle(code).paddingLeft)).not.toBe('0px');
});

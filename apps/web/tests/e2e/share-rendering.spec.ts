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

const TOKEN = 'ABCDEFGHIJ'.repeat(9);

for (const width of [390, 768, 1440]) {
  test(`a long unbroken word wraps inside the reply at ${width} px (#187)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openShare(page, `The key is ${TOKEN} and it never breaks.\n\nA hash: \`${TOKEN}\``);
    const reply = page.getByRole('article', { name: /Assistant message/ });
    // Rendered, not the plain-text fallback shown while the renderer loads.
    await expect(reply.locator('p', { hasText: 'The key is' })).toBeVisible();
    await expect(reply.locator('p')).toHaveCount(2);
    // The page itself does not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    // Every paragraph stays inside the reply's column.
    const column = (await reply.boundingBox())!;
    for (const paragraph of await reply.locator('p').all()) {
      const box = (await paragraph.boundingBox())!;
      const right = await paragraph.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return Math.max(...[...range.getClientRects()].map((rect) => rect.right));
      });
      expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 0.5);
      expect(right).toBeLessThanOrEqual(column.x + column.width + 0.5);
    }
  });
}

test("a reply's task-list checkboxes are named by their items (#240)", async ({ page }) => {
  await openShare(page, '- [x] Draft the survey questions\n- [ ] Conduct interviews');
  const reply = page.getByRole('article', { name: /Assistant message/ });
  await expect(reply.getByRole('checkbox', { name: 'Draft the survey questions' })).toBeChecked();
  await expect(reply.getByRole('checkbox', { name: 'Conduct interviews' })).not.toBeChecked();
  // The checkbox stands in for the bullet; the item does not show both.
  const markers = await reply
    .locator('li')
    .evaluateAll((items) => items.map((item) => getComputedStyle(item).listStyleType));
  expect(markers).toEqual(['none', 'none']);
});

const LONG_URL = `https://www.example.org/research/data-management/${'guidelines-'.repeat(6)}final`;

for (const width of [390, 1440]) {
  test(`a reply's list items wrap under their text, and a long link starts beside its bullet, at ${width} px (#241)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await openShare(
      page,
      [
        `- ${'Choose storage solutions that suit the organization and its data transformations. '.repeat(3)}`,
        `- ${LONG_URL}`,
        '',
        '1. First step',
        '   - A nested point that is long enough to wrap onto a second line at phone width, and at desktop width when repeated: a nested point that is long enough to wrap.',
      ].join('\n'),
    );
    const reply = page.getByRole('article', { name: /Assistant message/ });
    await expect(reply.locator('li')).toHaveCount(4);
    const lines = await reply.locator('li').evaluateAll((items) =>
      items.map((item) => {
        // The item's own text, without a nested list's.
        const range = document.createRange();
        range.setStart(item, 0);
        const nested = item.querySelector('ul, ol');
        if (nested) range.setEndBefore(nested);
        else range.setEnd(item, item.childNodes.length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
        const style = getComputedStyle(item);
        return {
          lefts: [...new Set(rects.map((rect) => Math.round(rect.left)))],
          rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
          firstTop: Math.min(...rects.map((rect) => rect.top)),
          contentTop: item.getBoundingClientRect().top + Number.parseFloat(style.paddingTop),
          lineHeight: Number.parseFloat(style.lineHeight),
        };
      }),
    );
    const [wrapped, link, , nested] = lines;
    // Wrapped lines line up with the first line's text, not under the bullet.
    for (const item of [wrapped, nested]) {
      expect(item!.rows).toBeGreaterThan(1);
      expect(item!.lefts).toHaveLength(1);
    }
    // The address begins on the bullet's line.
    expect(link!.firstTop - link!.contentTop).toBeLessThan(link!.lineHeight / 2);
  });
}

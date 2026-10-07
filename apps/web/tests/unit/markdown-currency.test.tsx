// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from '../../src/components/chat/markdown';
import { escapeCurrencyDollars } from '../../src/components/chat/markdown-currency';

/**
 * Amounts of money are not maths (#339), through the real lazily loaded
 * Streamdown renderer with its real maths plugin: "$5 for students, $10 for
 * staff" lost both dollar signs and became an italic formula.
 */
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

/** What a reader sees, one paragraph. */
const firstParagraph = () => container.querySelector('p')?.textContent;
const formulas = () => container.querySelectorAll('.katex').length;

describe('a reply (maths on)', () => {
  it.each([
    ['$5 for students, $10 for staff and $20 for guests'],
    ['Tickets cost $5–$10 each'],
    ['Tickets cost $5-$10 each'],
    ['from $20 to $30'],
    ['Total: $15'],
    ['Pay $20,$30 or $40'],
    ['It is $5 (or $6) today'],
  ])('shows %j as typed', async (text) => {
    await render(text);
    expect(firstParagraph()).toBe(text);
    expect(formulas()).toBe(0);
  });

  it('still typesets inline maths', async () => {
    await render('Pythagoras: $x^2 + y^2 = z^2$ holds.');
    expect(formulas()).toBe(1);
    expect(firstParagraph()).not.toContain('$');
  });

  it('typesets maths that starts with a digit', async () => {
    await render('The area is $2\\pi r$ here.');
    expect(formulas()).toBe(1);
  });

  it('typesets maths next to an amount', async () => {
    await render('It costs $5 and $10, while $x^2$ is a square.');
    expect(formulas()).toBe(1);
    expect(firstParagraph()).toContain('It costs $5 and $10, while ');
  });

  it('typesets display maths, on one line and on its own lines', async () => {
    await render('Here:\n\n$$\\int_0^1 x\\,dx$$\n\nAnd:\n\n$$\n\\sum_i i\n$$\n\nCosts $5 or $10.');
    await vi.waitFor(() => expect(container.querySelector('.katex-display')).not.toBeNull());
    expect(formulas()).toBe(2);
    expect(container.textContent).toContain('Costs $5 or $10.');
  });

  it('typesets the bracket forms models emit', async () => {
    await render('Inline \\( x \\) and costs $5 or $10.');
    expect(formulas()).toBe(1);
    expect(firstParagraph()).toContain('costs $5 or $10.');
  });

  it('leaves a literal "$ ... $" as written', async () => {
    await render('Write $ ... $ for maths.');
    expect(firstParagraph()).toBe('Write $ ... $ for maths.');
  });

  it('keeps dollar signs in code spans and fences', async () => {
    await render('Use `$5 and $10` here, and `$x$`.\n\n```sh\necho $HOME $PATH\n```');
    expect(formulas()).toBe(0);
    expect(container.querySelector('p code')?.textContent).toBe('$5 and $10');
    expect(container.querySelector('pre')?.textContent).toContain('echo $HOME $PATH');
  });

  it('keeps amounts in a table', async () => {
    await render('| Item | Price |\n| --- | --- |\n| Pass | $3 |\n| Pro | $12 |');
    const cells = [...container.querySelectorAll('td')].map((cell) => cell.textContent);
    expect(cells).toEqual(['Pass', '$3', 'Pro', '$12']);
  });

  it('keeps amounts in a list', async () => {
    await render('- $5 for students\n- $10 for staff');
    const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual(['$5 for students', '$10 for staff']);
  });
});

describe("a person's own message (maths off)", () => {
  it('shows the amounts as typed', async () => {
    const text = 'tickets cost $5 for students, $10 for staff and $20 for guests.';
    await render(text, false);
    expect(firstParagraph()).toBe(text);
    expect(formulas()).toBe(0);
  });

  it('shows "$$ ... $$" and "$ ... $" as typed', async () => {
    const text = 'LaTeX uses $$ ... $$ for display and $ ... $ for inline maths.';
    await render(text, false);
    expect(firstParagraph()).toBe(text);
    expect(formulas()).toBe(0);
  });

  it('shows even real-looking maths as typed', async () => {
    await render('Is $x^2$ right?', false);
    expect(firstParagraph()).toBe('Is $x^2$ right?');
  });
});

describe('escapeCurrencyDollars', () => {
  it('escapes amounts and nothing else', () => {
    expect(escapeCurrencyDollars('$5 and $10')).toBe('\\$5 and \\$10');
    expect(escapeCurrencyDollars('$x$ and $y$')).toBe('$x$ and $y$');
    expect(escapeCurrencyDollars('$$a$$ costs $5')).toBe('$$a$$ costs \\$5');
    expect(escapeCurrencyDollars('already \\$5 and \\$10')).toBe('already \\$5 and \\$10');
    expect(escapeCurrencyDollars('no dollars')).toBe('no dollars');
  });

  it('does not pair a dollar across paragraphs', () => {
    expect(escapeCurrencyDollars('costs $x\n\ny$ there')).toBe('costs \\$x\n\ny\\$ there');
  });

  it('leaves code alone, including a fence still streaming', () => {
    expect(escapeCurrencyDollars('`$5` and $5')).toBe('`$5` and \\$5');
    expect(escapeCurrencyDollars('```\n$5 and $10')).toBe('```\n$5 and $10');
  });
});

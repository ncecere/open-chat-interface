import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkLogicalCss, findInCss, findInSource, physicalUtility } from './check-logical-css.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

/** A throwaway repository root holding only the files given (path -> text or JSON). */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-logical-css-'));
  roots.push(root);
  const base = { 'scripts/i18n/physical-css-allowlist.json': { entries: [] } };
  for (const [path, content] of Object.entries({ ...base, ...files })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const found = (code) => findInSource('a.tsx', code).map((hit) => hit.utility);

describe('which class tokens are physical', () => {
  // node:test has no it.each: a loop keeps each case named.
  for (const token of [
    'ml-2',
    'mr-auto',
    '-ml-1',
    'pl-4',
    'pr-0.5',
    'ml-[3px]',
    'pl-(--gutter)',
    'left-0',
    'right-1/2',
    '-left-2',
    'left-[1.3rem]',
    'text-left',
    'text-right',
    'border-l',
    'border-r-2',
    'border-l-[var(--x)]',
    'rounded-l-lg',
    'rounded-r',
    'rounded-tl-xl',
    'rounded-br-md',
    'float-left',
    'clear-right',
    'scroll-ml-4',
    'scroll-pr-2',
    'translate-x-2',
    '-translate-x-1/2',
    'origin-left',
    'origin-top-right',
    'bg-left',
    'bg-linear-to-r',
    '[margin-left:4px]',
    '[padding-right:var(--x)]',
    '[text-align:left]',
    '[border-top-left-radius:4px]',
    // Variants do not hide it.
    'md:ml-2',
    'hover:pl-4',
    'group-hover:text-left',
    '[&>svg]:mr-1',
    'data-[state=open]:left-0',
    'md:hover:!pr-2',
    'pr-2!',
  ]) {
    it(`flags ${token}`, () => {
      assert.ok(physicalUtility(token), token);
    });
  }

  for (const token of [
    'ms-2',
    'me-auto',
    '-ms-1',
    'ps-4',
    'pe-0.5',
    'start-0',
    'end-1/2',
    'text-start',
    'text-end',
    'text-center',
    'border-s',
    'border-e-2',
    'border-t',
    'border-b-2',
    'border-red-500',
    'rounded-s-lg',
    'rounded-ee-md',
    'rounded-t-lg',
    'float-start',
    'mx-auto',
    'px-3',
    'inset-x-0',
    'gap-2',
    'space-x-2',
    'translate-x-0',
    '-translate-x-0',
    'translate-y-1/2',
    'rtl:ml-2',
    'ltr:pr-4',
    'md:rtl:left-0',
    'rtl:-scale-x-100',
    // Words and tokens that only look like utilities.
    'left',
    'right',
    'right-to-left',
    'left-to-right',
    'pr',
    'ml',
    'text-leftover',
    'prose-left',
    'mask-left',
  ]) {
    it(`allows ${token}`, () => {
      assert.equal(physicalUtility(token), null, token);
    });
  }

  it('says what to use instead', () => {
    assert.match(physicalUtility('ml-2').advice, /ms-/);
    assert.match(physicalUtility('left-0').advice, /start-/);
    assert.match(physicalUtility('text-right').advice, /text-end/);
    assert.match(physicalUtility('border-l-2').advice, /border-s/);
    assert.match(physicalUtility('rounded-tl-xl').advice, /rounded-ss/);
  });

  it('accepts a translate, an origin, a position and a gradient that have an rtl: counterpart', () => {
    assert.equal(
      physicalUtility('-translate-x-1/2', ['start-1/2', '-translate-x-1/2', 'rtl:translate-x-1/2']),
      null,
    );
    assert.ok(physicalUtility('-translate-x-1/2', ['start-1/2', '-translate-x-1/2']));
    // Another kind of rtl: variant is not a counterpart.
    assert.ok(physicalUtility('-translate-x-1/2', ['-translate-x-1/2', 'rtl:ms-2']));
    const to = '[mask-image:linear-gradient(to_right,#000,transparent)]';
    assert.ok(physicalUtility(to, [to]));
    assert.equal(
      physicalUtility(to, [to, 'rtl:[mask-image:linear-gradient(to_left,#000,transparent)]']),
      null,
    );
    assert.equal(physicalUtility('bg-linear-to-r', ['bg-linear-to-r', 'rtl:bg-linear-to-l']), null);
  });
});

describe('finding them in source', () => {
  it('reads class strings in cn(), conditionals, templates and attributes', () => {
    assert.deepEqual(
      found(`
        const a = <div className="flex ml-2 text-left" />;
        const b = cn('p-2', open && 'pr-4', open ? 'border-l' : 'border-r');
        const c = \`rounded-l-md \${x} mr-1\`;
        const d = <div className={\`pl-\${n}\`} />;
      `),
      ['ml-2', 'text-left', 'pr-4', 'border-l', 'border-r', 'rounded-l-md', 'mr-1', 'pl-'],
    );
  });

  it('reports the line', () => {
    const [hit] = findInSource('a.tsx', 'const a = 1;\n\nconst b = "ml-2";\n');
    assert.equal(hit.line, 3);
  });

  it('leaves comments, JSX text, import paths and prose alone', () => {
    assert.deepEqual(
      found(`
        import x from '../left-panel';
        // pl-4 would be wrong here
        /* ml-2 */
        const a = <p>Use pr-4 or text-left</p>;
        const b = 'The right-to-left layout';
        const c = 'turn left at the corner';
      `),
      [],
    );
  });

  it('reads style objects', () => {
    assert.deepEqual(
      found(`
        const a = <div style={{ marginLeft: 4, paddingRight: 2, left: 0, right: '1rem' }} />;
        const b = { textAlign: 'left', float: 'right', borderLeft: '1px solid', borderTopLeftRadius: 4 };
      `),
      [
        'marginLeft',
        'paddingRight',
        'left',
        'right',
        'textAlign: left',
        'float: right',
        'borderLeft',
        'borderTopLeftRadius',
      ],
    );
  });

  it('does not take left and right outside a style attribute for CSS', () => {
    assert.deepEqual(
      found(`
        const rect = { left: 1, right: 2 };
        const box = a.left + b.right;
        const t = { textAlign: 'center' };
        const logical = <div style={{ marginInlineStart: 4, insetInlineEnd: 0 }} />;
      `),
      [],
    );
  });

  it('accepts the logical forms of all of it', () => {
    assert.deepEqual(
      found(`
        const a = cn('ms-2 me-auto ps-4 pe-1 start-0 end-0 text-start text-end border-s border-e-2 rounded-s-lg rounded-ee-md');
        const b = <div style={{ marginInlineStart: 4, textAlign: 'start' }} />;
      `),
      [],
    );
  });
});

describe('icons that point', () => {
  it('flags a direction-bearing icon with no rtl: class', () => {
    assert.deepEqual(
      found(`
        const a = <ArrowLeft />;
        const b = <ChevronRight className="size-4" />;
        const c = <LogOut className={cn('size-4', open && 'rotate-90')} />;
        const d = <PanelLeftIcon aria-hidden="true" />;
        const e = <Send>x</Send>;
      `),
      ['<ArrowLeft>', '<ChevronRight>', '<LogOut>', '<PanelLeftIcon>', '<Send>'],
    );
  });

  it('accepts a flip or a rotation for right-to-left, in a string or an expression', () => {
    assert.deepEqual(
      found(`
        const a = <ArrowLeft className="rtl:-scale-x-100" />;
        const b = <ChevronRight className="size-4 rtl:rotate-180" />;
        const c = <ChevronRight className={cn('size-4', open ? 'rotate-90' : 'rtl:rotate-180')} />;
        const d = <ChevronLeft className="md:rtl:-scale-x-100" />;
      `),
      [],
    );
  });

  it('leaves icons that do not point alone, and ones that are not icons', () => {
    assert.deepEqual(
      found(`
        const a = <Play />;
        const b = <Plus className="size-4" />;
        const c = <History />;
        const d = <RotateCcw />;
        const e = <ChevronDown />;
        const f = <Chevron />;
      `),
      [],
    );
  });
});

describe('finding them in CSS', () => {
  it('reads physical properties, alignment values and @apply', () => {
    const hits = findInCss(`
      .a { margin-left: 1rem; padding-right: 2px; }
      .b { text-align: left; float: right; }
      .c { border-left: 3px solid; left: 0; border-top-left-radius: 4px }
      .d { @apply ml-2 text-right flex; }
    `);
    assert.deepEqual(
      hits.map((hit) => hit.utility),
      [
        'margin-left',
        'padding-right',
        'text-align: left',
        'float: right',
        'border-left',
        'left',
        'border-top-left-radius',
        'ml-2',
        'text-right',
      ],
    );
  });

  it('allows logical properties, comments and the scrollbar pseudo-elements', () => {
    assert.deepEqual(
      findInCss(`
        /* margin-left: 1rem; the old way */
        .a { margin-inline-start: 1rem; padding-inline-end: 2px; text-align: start; inset-inline-start: 0 }
        .b::-webkit-scrollbar { width: 8px; }
        .c { background-position: center; }
      `),
      [],
    );
  });
});

describe('the check against the allowlist', () => {
  const page = (className) => ({
    'apps/web/src/routes/page.tsx': `export const a = <div className="${className}" />;\n`,
  });
  const allow = (entries) => ({ 'scripts/i18n/physical-css-allowlist.json': { entries } });

  it('passes a page that is logical', () => {
    assert.deepEqual(checkLogicalCss(fixture(page('ms-2 text-start'))), []);
  });

  it('fails a new physical utility, naming the file, the line and the fix', () => {
    const problems = checkLogicalCss(fixture(page('flex ml-2')));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /apps\/web\/src\/routes\/page\.tsx:1: physical `ml-2`/);
    assert.match(problems[0], /ms-/);
  });

  it('fails one in a stylesheet and one in a style prop', () => {
    const root = fixture({
      'apps/web/src/styles/global.css': '.a { padding-left: 4px }\n',
      'apps/web/src/components/x.tsx': 'export const a = <i style={{ marginRight: 2 }} />;\n',
    });
    const problems = checkLogicalCss(root);
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => /global\.css:1: physical `padding-left`/.test(p)));
    assert.ok(problems.some((p) => /x\.tsx:1: physical `marginRight`/.test(p)));
  });

  it('allows what the allowlist lists, with a reason', () => {
    const root = fixture({
      ...page('left-full translate-x-2'),
      ...allow([
        {
          file: 'apps/web/src/routes/page.tsx',
          utility: 'left-full',
          count: 1,
          reason: 'Placed against the physical window edge it was measured against',
        },
        {
          file: 'apps/web/src/routes/page.tsx',
          utility: 'translate-x-2',
          count: 1,
          reason: 'Moves away from that edge',
        },
      ]),
    });
    assert.deepEqual(checkLogicalCss(root), []);
  });

  it('fails a second use beyond the allowed count', () => {
    const root = fixture({
      ...page('left-full left-full'),
      ...allow([
        {
          file: 'apps/web/src/routes/page.tsx',
          utility: 'left-full',
          count: 1,
          reason: 'a reason',
        },
      ]),
    });
    const problems = checkLogicalCss(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 uses of `left-full`, 1 allowed/);
  });

  it('makes the list shrink: fewer uses than allowed, or none, fails until the entry is lowered or removed', () => {
    const lowered = checkLogicalCss(
      fixture({
        ...page('left-full'),
        ...allow([
          { file: 'apps/web/src/routes/page.tsx', utility: 'left-full', count: 2, reason: 'why' },
        ]),
      }),
    );
    assert.match(lowered[0], /has 1 of `left-full` now, not 2; lower the count/);
    const gone = checkLogicalCss(
      fixture({
        ...page('ms-2'),
        ...allow([
          { file: 'apps/web/src/routes/page.tsx', utility: 'left-full', count: 1, reason: 'why' },
        ]),
      }),
    );
    assert.match(
      gone[0],
      /`left-full` in apps\/web\/src\/routes\/page\.tsx no longer appears; remove its entry/,
    );
  });

  it('wants a reason, a utility and a count on every entry', () => {
    for (const entry of [
      { file: 'a.tsx', utility: 'ml-2', count: 1 },
      { file: 'a.tsx', utility: 'ml-2', count: 1, reason: '  ' },
      { file: 'a.tsx', count: 1, reason: 'why' },
      { file: 'a.tsx', utility: 'ml-2', count: 0, reason: 'why' },
    ]) {
      const problems = checkLogicalCss(fixture({ ...page('ms-2'), ...allow([entry]) }));
      assert.ok(
        problems.some((p) =>
          /every entry needs file, utility, a count of 1 or more, and a reason/.test(p),
        ),
        JSON.stringify(entry),
      );
    }
  });

  it('only looks under apps/web/src', () => {
    const root = fixture({
      'apps/api/src/x.ts': 'export const a = "ml-2";\n',
      'apps/web/tests/e2e/x.ts': 'export const a = "ml-2";\n',
    });
    assert.deepEqual(checkLogicalCss(root), []);
  });
});

describe('the repository itself', () => {
  it('passes, from the command line too', () => {
    assert.deepEqual(checkLogicalCss(REPO), []);
    const out = execFileSync('node', [join(REPO, 'scripts/check-logical-css.mjs')], {
      encoding: 'utf8',
    });
    assert.match(out, /Logical CSS check passed/);
  });

  it('exits non-zero and says what is wrong', () => {
    const root = fixture({ 'apps/web/src/a.tsx': 'export const a = "pl-4";\n' });
    assert.throws(
      () =>
        execFileSync('node', [join(REPO, 'scripts/check-logical-css.mjs'), '--root', root], {
          stdio: 'pipe',
          encoding: 'utf8',
        }),
      (error) =>
        error.status === 1 && /Logical CSS check failed \(1\)[\s\S]*pl-4/.test(error.stderr),
    );
  });

  it('keeps every allowlist entry justified in a sentence', async () => {
    const { default: list } = await import('./i18n/physical-css-allowlist.json', {
      with: { type: 'json' },
    });
    for (const entry of list.entries) {
      assert.ok(entry.reason.length > 30, `${entry.file} ${entry.utility}: reason too thin`);
    }
  });
});

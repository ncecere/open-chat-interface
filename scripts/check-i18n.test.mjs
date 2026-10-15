import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCatalogs, checkFormatting, checkI18n, checkLiterals } from './check-i18n.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

/** A throwaway repository root holding only the files given (path -> text or JSON). */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-i18n-'));
  roots.push(root);
  const base = {
    'scripts/i18n/migrated.json': { directories: [] },
    'scripts/i18n/literal-allowlist.json': { entries: [] },
    'scripts/i18n/format-allowlist.json': { files: [] },
    'apps/web/src/locales/en.json': { 'area.title': 'Title' },
  };
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
const locale = (tag, catalog) => ({ [`apps/web/src/locales/${tag}.json`]: catalog });
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the repository itself', () => {
  it('passes, from the command line too', () => {
    assert.deepEqual(checkI18n(REPO), []);
    const out = execFileSync('node', [join(REPO, 'scripts/check-i18n.mjs')], { encoding: 'utf8' });
    assert.match(out, /i18n check passed/);
  });

  it('exits non-zero and says what is wrong', () => {
    const root = fixture({ ...locale('es', {}) });
    assert.throws(
      () =>
        execFileSync('node', [join(REPO, 'scripts/check-i18n.mjs'), '--root', root], {
          stdio: 'pipe',
        }),
      (error) => error.status === 1 && /es: missing key area\.title/.test(String(error.stderr)),
    );
  });
});

describe('catalogs', () => {
  it('accept a complete locale', () => {
    const root = fixture({ ...locale('es', { 'area.title': 'Título' }) });
    assert.deepEqual(checkCatalogs(root), []);
  });

  it('fail on a key en has and the locale lacks', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'area.title': 'Title', 'area.other': 'Other' },
      ...locale('es', { 'area.title': 'Título' }),
    });
    assert.deepEqual(checkCatalogs(root), ['es: missing key area.other']);
  });

  it('fail on a key the locale has and en lacks', () => {
    const root = fixture({ ...locale('es', { 'area.title': 'Título', 'area.stray': 'x' }) });
    assert.deepEqual(checkCatalogs(root), ['es: extra key area.stray (not in en)']);
  });

  it('fail when placeholders differ: renamed, dropped, added, or of another kind', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': {
        'a.greeting': 'Hello {name}',
        'a.size': 'Size {n, number}',
        'a.plain': 'Plain',
        'a.date': 'On {d, date, short}',
      },
      ...locale('es', {
        'a.greeting': 'Hola {nombre}',
        'a.size': 'Tamaño {n}',
        'a.plain': 'Llano {x}',
        'a.date': 'El {d, date, short}',
      }),
    });
    const problems = checkCatalogs(root);
    assert.equal(problems.length, 3);
    assert.match(
      problems[0],
      /es: a\.greeting has placeholders \[\{nombre\}\]; en has \[\{name\}\]/,
    );
    assert.match(problems[1], /a\.size has placeholders \[\{n\}\]; en has \[\{n, number\}\]/);
    assert.match(problems[2], /a\.plain has placeholders \[\{x\}\]; en has \[\]/);
  });

  const plural = '{count, plural, one {# file} other {# files}}';

  it('need each language’s own plural categories: Arabic six, Spanish three, English two', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'f.count': plural },
      ...locale('es', {
        'f.count': '{count, plural, one {# archivo} many {# de archivos} other {# archivos}}',
      }),
      ...locale('ar', {
        'f.count': '{count, plural, zero {z} one {o} two {t} few {# f} many {# m} other {# ملف}}',
      }),
    });
    assert.deepEqual(checkCatalogs(root), []);
  });

  it('fail on missing or surplus plural categories', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'f.count': plural },
      // Arabic with English's two forms; Spanish without many.
      ...locale('ar', { 'f.count': plural }),
      ...locale('es', { 'f.count': '{count, plural, one {# archivo} other {# archivos}}' }),
    });
    const problems = checkCatalogs(root);
    assert.equal(problems.length, 2);
    assert.match(
      problems.join('\n'),
      /ar: f\.count plural "count" has one, other; ar needs zero, one, two, few, many, other/,
    );
    assert.match(
      problems.join('\n'),
      /es: f\.count plural "count" has one, other; es needs one, many, other/,
    );
  });

  it('fail when English itself uses a category English never selects', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'f.count': '{count, plural, one {a} few {b} other {c}}' },
    });
    assert.match(
      checkCatalogs(root)[0],
      /en: f\.count plural "count" has one, few, other; en needs one, other/,
    );
  });

  it('fail when a translation is no longer a plural, or counts something else', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'f.count': plural },
      ...locale('es', { 'f.count': '{n} archivos' }),
    });
    assert.match(
      checkCatalogs(root)[0],
      /es: f\.count has placeholders \[\{n\}\]; en has \[\{count, plural\}\]/,
    );
  });

  it('fail on a message that does not parse, in any locale', () => {
    const root = fixture({
      'apps/web/src/locales/en.json': { 'a.title': 'Hello {name' },
      ...locale('es', { 'a.title': 'Hola {nombre}}' }),
    });
    const problems = checkCatalogs(root);
    assert.match(problems.join('\n'), /en: a\.title is not a valid message/);
    assert.match(problems.join('\n'), /es: a\.title is not a valid message/);
  });

  it('fail on a key that does not follow the naming rule, a non-string, and bad JSON', () => {
    assert.match(
      checkCatalogs(fixture({ 'apps/web/src/locales/en.json': { Title: 'x' } }))[0],
      /key "Title"/,
    );
    assert.match(
      checkCatalogs(fixture({ ...locale('es', { 'area.title': 3 }) }))[0],
      /es: area\.title is not a string/,
    );
    assert.match(
      checkCatalogs(fixture({ 'apps/web/src/locales/es.json': '{ nope' }))[0],
      /es\.json: not valid JSON/,
    );
  });

  it('fail when en.json is missing, and on a locale tag the runtime does not know', () => {
    assert.match(
      checkCatalogs(fixture({ 'apps/web/src/locales/en.json': null, ...locale('es', {}) }))[0],
      /en\.json is missing/,
    );
    assert.match(
      checkCatalogs(fixture({ ...locale('not_a_tag', { 'area.title': 'x' }) }))[0],
      /not_a_tag: not a language tag/,
    );
  });
});

describe('literals in migrated directories', () => {
  const migrated = (extra = {}) => ({
    'scripts/i18n/migrated.json': { directories: ['apps/web/src/components/auth'] },
    ...extra,
  });
  const component = (body) => `export function A() {\n  return (\n    ${body}\n  );\n}\n`;

  it('ignore every directory until it is listed', () => {
    const root = fixture({
      'apps/web/src/components/auth/a.tsx': component('<p>Hello</p>'),
    });
    assert.deepEqual(checkLiterals(root), []);
  });

  it('fail on JSX text', () => {
    const root = fixture(
      migrated({ 'apps/web/src/components/auth/a.tsx': component('<p>Sign in to continue</p>') }),
    );
    const [problem, ...rest] = checkLiterals(root);
    assert.equal(rest.length, 0);
    assert.match(
      problem,
      /^apps\/web\/src\/components\/auth\/a\.tsx:3: text "Sign in to continue" is not a t\(\) call/,
    );
  });

  it('fail on text beside an expression, and on a string literal as a child', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/a.tsx': component(
          "<p>Hello {name}<b>{'Bold words'}</b>{`more words`}</p>",
        ),
      }),
    );
    const problems = checkLiterals(root).join('\n');
    assert.match(problems, /text "Hello"/);
    assert.match(problems, /text "Bold words"/);
    assert.match(problems, /text "more words"/);
  });

  it('fail on aria-label, title, placeholder and alt literals, in both spellings', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/a.tsx': component(
          `<div aria-label="Close" title={'Close it'}><input placeholder="Email" /><img alt="Logo of the school" /></div>`,
        ),
      }),
    );
    const problems = checkLiterals(root).join('\n');
    assert.match(problems, /aria-label attribute "Close"/);
    assert.match(problems, /title attribute "Close it"/);
    assert.match(problems, /placeholder attribute "Email"/);
    assert.match(problems, /alt attribute "Logo of the school"/);
  });

  it('accept t() calls, other attributes, an empty alt, and text with no words', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/a.tsx': component(
          `<div className="flex gap-2" data-testid="card" aria-label={t('a.close')} title={name}><img alt="" src="x.png" /><span>—</span><span>{count} / {max}</span><p>{t('a.hello', { name })}</p></div>`,
        ),
      }),
    );
    assert.deepEqual(checkLiterals(root), []);
  });

  it('look in nested directories and only .tsx files', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/deep/er/a.tsx': component('<p>Deep text</p>'),
        'apps/web/src/components/auth/notes.ts': "export const x = '<p>Not JSX</p>';",
        'apps/web/src/components/other/b.tsx': component('<p>Elsewhere</p>'),
      }),
    );
    const problems = checkLiterals(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /deep\/er\/a\.tsx:3/);
  });

  it('accept an allowlisted literal that has a reason', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/a.tsx': component('<code>OCI_API_KEY</code>'),
        'scripts/i18n/literal-allowlist.json': {
          entries: [
            {
              file: 'apps/web/src/components/auth/a.tsx',
              text: 'OCI_API_KEY',
              reason: 'an environment variable name, shown as written',
            },
          ],
        },
      }),
    );
    assert.deepEqual(checkLiterals(root), []);
  });

  it('refuse an allowlist entry with no reason, and one that no longer matches', () => {
    const root = fixture(
      migrated({
        'apps/web/src/components/auth/a.tsx': component('<code>OCI_API_KEY</code>'),
        'scripts/i18n/literal-allowlist.json': {
          entries: [
            { file: 'apps/web/src/components/auth/a.tsx', text: 'OCI_API_KEY', reason: ' ' },
            { file: 'apps/web/src/components/auth/a.tsx', text: 'Gone', reason: 'was here' },
          ],
        },
      }),
    );
    const problems = checkLiterals(root).join('\n');
    assert.match(problems, /every entry needs file, text and a reason/);
    assert.match(problems, /"Gone" in apps\/web\/src\/components\/auth\/a\.tsx is no longer there/);
  });

  it('fail when a listed directory does not exist', () => {
    const root = fixture({ 'scripts/i18n/migrated.json': { directories: ['apps/web/src/nope'] } });
    assert.match(checkLiterals(root)[0], /apps\/web\/src\/nope is not a directory/);
  });
});

describe('locale formatting outside the formatter', () => {
  const src = (file, body) => ({ [`apps/web/src/${file}`]: body });

  it('fail on toLocale*String and Intl formatters in a file the allowlist does not name', () => {
    const root = fixture({
      ...src('a.ts', 'export const a = (n: number) => n.toLocaleString();'),
      ...src(
        'b.ts',
        "export const b = (d: Date) => d.toLocaleDateString('en', { month: 'long' });",
      ),
      ...src('c.ts', "export const c = new Intl.NumberFormat('en');"),
      ...src(
        'd.ts',
        'export const d = () => new Intl.DateTimeFormat().format(new Date()) + new Date().toLocaleTimeString();',
      ),
      ...src(
        'e.ts',
        "export const e = [new Intl.RelativeTimeFormat('en'), new Intl.ListFormat('en'), new Intl.DisplayNames('en', { type: 'region' })];",
      ),
    });
    const problems = checkFormatting(root);
    assert.equal(problems.length, 5);
    assert.match(problems[0], /a\.ts: 1 locale-formatting call\(s\)/);
    assert.match(problems[3], /d\.ts: 2 locale-formatting call/);
    assert.match(problems[4], /e\.ts: 3 locale-formatting call/);
  });

  it('allow the formatter itself, plural rules, comparison and text that only mentions them', () => {
    const root = fixture({
      ...src(
        'lib/i18n/format.ts',
        "export const f = (n: number) => new Intl.NumberFormat('en').format(n) + n.toLocaleString();",
      ),
      ...src(
        'p.ts',
        "export const p = new Intl.PluralRules('en'); export const s = (a: string, b: string) => a.localeCompare(b);",
      ),
      ...src(
        't.tsx',
        "// n.toLocaleString() is how it used to be done\nexport const m = 'Intl.NumberFormat and toLocaleString()'; export const g = Number.prototype.toLocaleString;",
      ),
    });
    assert.deepEqual(checkFormatting(root), []);
  });

  it('allow the sites that were there, per file, and fail a new one in the same file', () => {
    const files = {
      ...src('old.ts', 'export const a = (n: number) => n.toLocaleString() + n.toLocaleString();'),
    };
    const allow = (count) => ({
      'scripts/i18n/format-allowlist.json': {
        files: [
          { file: 'apps/web/src/old.ts', count, reason: 'step 2: converts with the sharing page' },
        ],
      },
    });
    assert.deepEqual(checkFormatting(fixture({ ...files, ...allow(2) })), []);
    assert.match(
      checkFormatting(fixture({ ...files, ...allow(1) }))[0],
      /old\.ts: 2 locale-formatting calls, 1 allowed/,
    );
  });

  it('make the list shrink: a lower count or a converted file must be removed from it', () => {
    const allow = (count) => ({
      'scripts/i18n/format-allowlist.json': {
        files: [{ file: 'apps/web/src/old.ts', count, reason: 'step 2' }],
      },
    });
    const one = src('old.ts', 'export const a = (n: number) => n.toLocaleString();');
    assert.match(
      checkFormatting(fixture({ ...one, ...allow(3) }))[0],
      /old\.ts has 1 now, not 3; lower the count/,
    );
    const none = src('old.ts', 'export const a = 1;');
    assert.match(
      checkFormatting(fixture({ ...none, ...allow(1) }))[0],
      /old\.ts has no locale-formatting calls left; remove its entry/,
    );
  });

  it('refuse an entry without a reason', () => {
    const root = fixture({
      ...src('old.ts', 'export const a = (n: number) => n.toLocaleString();'),
      'scripts/i18n/format-allowlist.json': { files: [{ file: 'apps/web/src/old.ts', count: 1 }] },
    });
    assert.match(checkFormatting(root).join('\n'), /every entry needs file, count and a reason/);
  });
});

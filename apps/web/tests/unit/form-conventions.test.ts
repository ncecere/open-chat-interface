import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Conventions every form keeps, checked over the source so a new form cannot
// quietly miss them. Each walk since the second found a form the last fix had
// not reached (#46, #178, #217, #226, #257, #283, #300, #302, #320).

const SRC = join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

/**
 * Every `<form …>` opening tag in `source`. A tag ends at the first `>`
 * outside braces and quotes, so `onSubmit={(event) => …}` does not end it.
 */
function formTags(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<form\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    for (let index = match.index + 5; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== '\\') quote = null;
      } else if (char === '"' || char === "'" || char === '`') {
        quote = char;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === '>' && depth === 0) {
        tags.push(source.slice(match.index, index + 1));
        break;
      }
    }
  }
  return tags;
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  source: readFileSync(path, 'utf8'),
}));

describe('formTags', () => {
  it('reads a tag whose attributes contain arrows and braces', () => {
    const tags = formTags(
      '<form\n  onSubmit={(event) => { if (a > b) submit(); }}\n  noValidate\n>\n<p />',
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('noValidate');
  });
});

it('every form uses the app’s own validation messages, never the browser’s bubble (#320)', () => {
  // The browser stops a submit at the first `required`, `min`, `max`,
  // `pattern` or `type="email"` field with its own tooltip, one field at a
  // time, in its own words, gone on the next click and not tied to the field.
  // Our forms check every field and show each problem under it (#283, #302),
  // so every form opts out with noValidate, including one with no such
  // attribute yet: a field gains a `min` more easily than its form a check.
  const forms = files.flatMap(({ path, source }) => formTags(source).map((tag) => ({ path, tag })));
  // The sweep found this many; a much smaller number means the scan broke.
  expect(forms.length).toBeGreaterThan(50);
  const native = forms.filter(({ tag }) => !/\bnoValidate\b/.test(tag)).map(({ path }) => path);
  expect(native).toEqual([]);
});

/**
 * Forms that write without registering protection themselves, and why that
 * is right. Anything else that saves must ask before its edit is lost.
 */
const PROTECTED_ELSEWHERE: Record<string, string> = {
  'routes/admin/storage/storage-settings-form.tsx':
    'its state lives in useStorageSettings (use-storage-settings.ts), which reports it',
  'routes/admin/users/saved-views.tsx':
    'names a view of the filters in the address; only the typed name is at stake',
  'components/admin/operations/destination.tsx':
    'fields inside the Backups and Compliance forms, which report their edits',
};

/** Where forms ask before unsaved edits are left behind: administration and settings. */
const GUARDED_DIRS = [
  'routes/admin/',
  'routes/settings/',
  'components/admin/',
  'components/settings/',
];

it('every admin and settings form that saves asks before its edit is left behind (#300, #314)', () => {
  // A form that saves: it submits, or it has a Save button, and it writes.
  const saves = (source: string) =>
    (formTags(source).length > 0 || /(>|^)\s*Save\b/m.test(source)) &&
    /\bapi\.(put|patch|post)\b|authClient\.(updateUser|changePassword)\b/.test(source);
  // A page form reports to its layout's guard; a dialog asks on Escape.
  const guarded = (source: string) =>
    /\buseReportUnsaved\(|\buseEditedSince\(|\bconfirmDiscard\b/.test(source);
  const forms = files.filter(
    ({ path, source }) => GUARDED_DIRS.some((dir) => path.startsWith(dir)) && saves(source),
  );
  // The sweep found this many; a much smaller number means the scan broke.
  expect(forms.length).toBeGreaterThan(30);
  const unguarded = forms
    .filter(({ path, source }) => !guarded(source) && !(path in PROTECTED_ELSEWHERE))
    .map(({ path }) => path);
  expect(unguarded).toEqual([]);
  // The hook that protects the Storage form still does.
  expect(readFileSync(join(SRC, 'routes/admin/storage/use-storage-settings.ts'), 'utf8')).toContain(
    'useReportUnsaved(',
  );
});

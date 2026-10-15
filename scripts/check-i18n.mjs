#!/usr/bin/env node
// The translation checks (v0.14, #397); `pnpm lint` runs them and CI with it.
// What they enforce, and how to fix each, is in docs/dev/translations.md.
//
//  1. Catalogs (apps/web/src/locales/*.json): every locale has exactly the keys
//     `en` has; each message parses; placeholders (name and kind) are the same
//     as English; each plural has the categories its language needs (CLDR, from
//     Intl.PluralRules), so Arabic has six where English has two.
//  2. Migrated directories (scripts/i18n/migrated.json): no JSX text and no
//     aria-label, title, placeholder or alt literal that is not a t() call,
//     except what scripts/i18n/literal-allowlist.json lists with a reason.
//  3. No new locale-formatting call sites (toLocale*String, Intl.NumberFormat,
//     DateTimeFormat, RelativeTimeFormat, ListFormat, DisplayNames) outside
//     apps/web/src/lib/i18n/format.ts. The ones that exist are counted per file
//     in scripts/i18n/format-allowlist.json, each justified; the count may only
//     go down (a file that now has fewer must have its count lowered).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describeMessage } from '../apps/web/src/lib/i18n/message-parse.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const LOCALES_DIR = 'apps/web/src/locales';
export const WEB_SRC = 'apps/web/src';
export const FORMATTER = 'apps/web/src/lib/i18n/format.ts';
export const MIGRATED = 'scripts/i18n/migrated.json';
export const LITERAL_ALLOWLIST = 'scripts/i18n/literal-allowlist.json';
export const FORMAT_ALLOWLIST = 'scripts/i18n/format-allowlist.json';

/** Attributes whose string value a person reads (or a screen reader speaks). */
export const TEXT_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];
const SOURCE_LOCALE = 'en';
const KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
const LOCALE_FORMATTERS = new Set([
  'NumberFormat',
  'DateTimeFormat',
  'RelativeTimeFormat',
  'ListFormat',
  'DisplayNames',
]);
const LOCALE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const posix = (path) => path.split(sep).join('/');

function walk(directory, extensions, out = []) {
  if (!existsSync(directory)) return out;
  for (const name of readdirSync(directory).sort()) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, extensions, out);
    else if (extensions.some((extension) => name.endsWith(extension))) out.push(path);
  }
  return out;
}

/** The categories a language needs in a plural, from CLDR via the runtime. */
function pluralCategoriesOf(locale) {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
const argText = (arg) => `{${arg.name}${arg.type === 'arg' ? '' : `, ${arg.type}`}}`;

// 1. Catalogs ---------------------------------------------------------------

export function checkCatalogs(root) {
  const problems = [];
  const directory = join(root, LOCALES_DIR);
  if (!existsSync(directory)) return [`${LOCALES_DIR} does not exist`];
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (!files.includes(`${SOURCE_LOCALE}.json`)) return [`${LOCALES_DIR}/en.json is missing`];

  const catalogs = new Map();
  for (const file of files) {
    const locale = file.slice(0, -'.json'.length);
    try {
      catalogs.set(locale, readJson(join(directory, file)));
    } catch (error) {
      problems.push(`${LOCALES_DIR}/${file}: not valid JSON (${error.message})`);
    }
  }
  const source = catalogs.get(SOURCE_LOCALE);
  if (!source) return problems;

  const describe = (locale, key, message) => {
    if (typeof message !== 'string') {
      problems.push(`${locale}: ${key} is not a string`);
      return null;
    }
    try {
      return describeMessage(message);
    } catch (error) {
      problems.push(`${locale}: ${key} is not a valid message: ${error.message}`);
      return null;
    }
  };

  for (const key of Object.keys(source)) {
    if (!KEY.test(key)) {
      problems.push(
        `en: key "${key}" is not area.name in camelCase (see docs/dev/translations.md)`,
      );
    }
  }

  for (const [locale, catalog] of catalogs) {
    let categories;
    try {
      categories = pluralCategoriesOf(locale);
    } catch {
      problems.push(`${locale}: not a language tag this runtime knows`);
      continue;
    }
    if (locale !== SOURCE_LOCALE) {
      for (const key of Object.keys(source)) {
        if (!(key in catalog)) problems.push(`${locale}: missing key ${key}`);
      }
      for (const key of Object.keys(catalog)) {
        if (!(key in source)) problems.push(`${locale}: extra key ${key} (not in en)`);
      }
    }
    for (const [key, message] of Object.entries(catalog)) {
      const mine = describe(locale, key, message);
      if (!mine) continue;

      for (const [name, found] of Object.entries(mine.plurals)) {
        // A language is checked against its own categories, not English's: a
        // translation with fewer is missing forms, with more has forms no
        // number of that language ever selects.
        if (!sameList(found, sortCategories(categories))) {
          problems.push(
            `${locale}: ${key} plural "${name}" has ${found.join(', ')}; ${locale} needs ${sortCategories(categories).join(', ')}`,
          );
        }
      }

      if (locale === SOURCE_LOCALE || !(key in source)) continue;
      const theirs = describe(SOURCE_LOCALE, key, source[key]);
      if (!theirs) continue;
      const want = theirs.args.map(argText).join(' ');
      const have = mine.args.map(argText).join(' ');
      if (want !== have) {
        problems.push(`${locale}: ${key} has placeholders [${have}]; en has [${want}]`);
      }
    }
  }
  return problems;
}

const ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const sortCategories = (list) => ORDER.filter((category) => list.includes(category));

// 2. Literals in migrated directories ---------------------------------------

const hasLetters = (text) => /\p{L}/u.test(text);

function literalsIn(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText(source).replace(/\s+/g, ' ').trim();
      if (hasLetters(text)) found.push({ text, line: lineOf(node), kind: 'text' });
    } else if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      // {'Some text'} as a child.
      const expression = node.expression;
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        if (hasLetters(expression.text)) {
          found.push({ text: expression.text, line: lineOf(node), kind: 'text' });
        }
      }
    } else if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.includes(node.name.getText(source))) {
      const initializer = node.initializer;
      const literal =
        initializer && ts.isStringLiteral(initializer)
          ? initializer
          : initializer &&
              ts.isJsxExpression(initializer) &&
              initializer.expression &&
              (ts.isStringLiteral(initializer.expression) ||
                ts.isNoSubstitutionTemplateLiteral(initializer.expression))
            ? initializer.expression
            : null;
      if (literal && hasLetters(literal.text)) {
        found.push({ text: literal.text, line: lineOf(node), kind: node.name.getText(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function checkLiterals(root) {
  const problems = [];
  const listPath = join(root, MIGRATED);
  if (!existsSync(listPath)) return [`${MIGRATED} does not exist`];
  const directories = readJson(listPath).directories ?? [];
  const allowPath = join(root, LITERAL_ALLOWLIST);
  const allow = existsSync(allowPath) ? (readJson(allowPath).entries ?? []) : [];
  const used = new Set();

  for (const entry of allow) {
    if (!entry.file || !entry.text || !String(entry.reason ?? '').trim()) {
      problems.push(`${LITERAL_ALLOWLIST}: every entry needs file, text and a reason`);
    }
  }

  for (const directory of directories) {
    const absolute = join(root, directory);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      problems.push(`${MIGRATED}: ${directory} is not a directory`);
      continue;
    }
    for (const path of walk(absolute, ['.tsx'])) {
      const file = posix(relative(root, path));
      for (const literal of literalsIn(file, readFileSync(path, 'utf8'))) {
        const index = allow.findIndex(
          (entry) => entry.file === file && entry.text === literal.text,
        );
        if (index >= 0) {
          used.add(index);
          continue;
        }
        const where = literal.kind === 'text' ? 'text' : `${literal.kind} attribute`;
        problems.push(
          `${file}:${literal.line}: ${where} "${literal.text}" is not a t() call (add a key to en.json, or allowlist it with a reason)`,
        );
      }
    }
  }
  allow.forEach((entry, index) => {
    if (!used.has(index) && entry.file) {
      problems.push(
        `${LITERAL_ALLOWLIST}: "${entry.text}" in ${entry.file} is no longer there; remove it`,
      );
    }
  });
  return problems;
}

// 3. Locale formatting outside the formatter ---------------------------------

function formattingSitesIn(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let count = 0;
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Intl' &&
        LOCALE_FORMATTERS.has(name)
      ) {
        count++;
      } else if (LOCALE_METHODS.has(name) && ts.isCallExpression(node.parent)) {
        count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

export function checkFormatting(root) {
  const problems = [];
  const allowPath = join(root, FORMAT_ALLOWLIST);
  const allow = existsSync(allowPath) ? (readJson(allowPath).files ?? []) : [];
  const byFile = new Map();
  for (const entry of allow) {
    if (!entry.file || !Number.isInteger(entry.count) || !String(entry.reason ?? '').trim()) {
      problems.push(`${FORMAT_ALLOWLIST}: every entry needs file, count and a reason`);
    } else byFile.set(entry.file, entry);
  }

  const seen = new Set();
  for (const path of walk(join(root, WEB_SRC), ['.ts', '.tsx'])) {
    const file = posix(relative(root, path));
    if (file === FORMATTER) continue;
    const count = formattingSitesIn(file, readFileSync(path, 'utf8'));
    if (count === 0) continue;
    seen.add(file);
    const allowed = byFile.get(file)?.count ?? 0;
    if (count > allowed) {
      problems.push(
        allowed === 0
          ? `${file}: ${count} locale-formatting call(s) (toLocale*String, Intl.NumberFormat, ...) outside ${FORMATTER}; use formatNumber, formatDate, formatRelativeTime, formatList or formatFileSize from '~/lib/i18n'`
          : `${file}: ${count} locale-formatting calls, ${allowed} allowed in ${FORMAT_ALLOWLIST}; use ~/lib/i18n for the new one`,
      );
    } else if (count < allowed) {
      problems.push(
        `${FORMAT_ALLOWLIST}: ${file} has ${count} now, not ${allowed}; lower the count (the list only shrinks)`,
      );
    }
  }
  for (const file of byFile.keys()) {
    if (!seen.has(file)) {
      problems.push(
        `${FORMAT_ALLOWLIST}: ${file} has no locale-formatting calls left; remove its entry`,
      );
    }
  }
  return problems;
}

export function checkI18n(root) {
  return [...checkCatalogs(root), ...checkLiterals(root), ...checkFormatting(root)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArgument = process.argv.indexOf('--root');
  const root = rootArgument > 0 ? resolve(process.argv[rootArgument + 1]) : resolve(HERE, '..');
  const problems = checkI18n(root);
  if (problems.length > 0) {
    console.error(
      `i18n check failed (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log('i18n check passed.');
}

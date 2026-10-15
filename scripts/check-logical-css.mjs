#!/usr/bin/env node
// The right-to-left check (v0.14, #397); `pnpm lint` runs it, and CI with it.
//
// A page mirrors for Arabic only when its spacing, alignment and positions are
// LOGICAL (start/end) rather than PHYSICAL (left/right). This fails on a new
// physical utility under apps/web/src, so a layout that is added later cannot
// quietly break in right-to-left. What it looks at:
//
//  - Tailwind classes in any string or template of a .ts/.tsx file (variants
//    such as `md:` `hover:` `[&>svg]:` `data-[open]:` are stripped first):
//    ml- mr- pl- pr- left- right- text-left/right border-l/r(-*)
//    rounded-l/r/tl/tr/bl/br scroll-m|p-l/r float-/clear-left/right
//    translate-x- origin-left/right bg-left/right object-left/right,
//    gradients toward l/r, and arbitrary properties such as
//    `[margin-left:4px]`. A class that has an `rtl:` or `ltr:` counterpart in
//    the same string is deliberate and passes.
//  - Style objects: marginLeft paddingLeft borderLeft* ... textAlign: 'left',
//    float, and `left`/`right` inside a `style={{ }}`.
//  - `:dir()` in a class or a stylesheet: the CSS build compiles it to `:lang()`,
//    which does not mean the same thing.
//  - Icons that point (a chevron, an arrow, back, send, sign out, the sidebar
//    toggle, "open in new") must carry an `rtl:` class (`rtl:-scale-x-100`, or
//    `rtl:rotate-180` for one that also turns): <ChevronRight />, <ArrowLeft />
//    and the rest of DIRECTION_ICONS. Icons that do not point (a plus, a clock,
//    a play button) must not be mirrored and are not checked.
//  - .css files: margin-left, padding-right, left:, text-align: left, ... and
//    the same utilities in `@apply`.
//
// What is allowed to stay physical is listed, with a reason, in
// scripts/i18n/physical-css-allowlist.json (a fixed anchor, the scrollbar, a
// symmetric centring trick). The count per file and utility may only go down;
// an entry that no longer matches fails, like the other i18n allowlists.
// docs/dev/translations.md says how to convert each utility.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));

export const WEB_SRC = 'apps/web/src';
export const ALLOWLIST = 'scripts/i18n/physical-css-allowlist.json';

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

// Classes -------------------------------------------------------------------

/** [pattern, what to use instead], tried against a utility with variants and `-`/`!` removed. */
const UTILITIES = [
  [/^m[lr]-/, 'ms-* / me-* (margin-inline)'],
  [/^p[lr]-/, 'ps-* / pe-* (padding-inline)'],
  [/^scroll-m[lr]-/, 'scroll-ms-* / scroll-me-*'],
  [/^scroll-p[lr]-/, 'scroll-ps-* / scroll-pe-*'],
  [/^(?:left|right)-/, 'start-* / end-* (inset-inline)'],
  [/^text-(?:left|right)$/, 'text-start / text-end'],
  [/^border-[lr](?:-|$)/, 'border-s / border-e (and border-s-* / border-e-*)'],
  [/^rounded-(?:l|r|tl|tr|bl|br)(?:-|$)/, 'rounded-s / rounded-e / rounded-ss / -se / -es / -ee'],
  [/^(?:float|clear)-(?:left|right)$/, 'float-start / float-end, clear-start / clear-end'],
  [/^translate-x-/, 'a logical position, or an rtl: counterpart in the same string'],
  [/^origin-(?:top-|bottom-)?(?:left|right)$/, 'an rtl: counterpart for the transform origin'],
  [/^(?:bg|object)-(?:left|right)(?:-|$)/, 'an rtl: counterpart for the position'],
  [/^bg-(?:linear|gradient)-to-(?:l|r|tl|tr|bl|br)$/, 'an rtl: counterpart for the direction'],
  [/^bg-linear-(?:90|270|\[)/, 'an rtl: counterpart for the direction'],
];
/** A gradient or mask that runs toward a physical side inside an arbitrary value. */
const PHYSICAL_GRADIENT = /^\[.*\bto[_-](?:left|right)\b/;
const ARBITRARY_PROPERTY =
  /^\[(?:margin|padding|scroll-margin|scroll-padding)-(?:left|right):|^\[(?:left|right|float|clear):|^\[text-align:(?:left|right)\]|^\[border-(?:left|right)(?:-[a-z]+)?:|^\[border-(?:top|bottom)-(?:left|right)-radius:/;

/** Splits on `:` outside brackets: `md:[&>svg]:ml-2` -> ['md', '[&>svg]', 'ml-2']. */
export function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    const character = token[index];
    if (character === '[' || character === '(') depth++;
    else if (character === ']' || character === ')') depth--;
    else if (character === ':' && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

/** The utility itself: no variants, no leading `!` or `-`, no trailing `!`, no `/opacity`. */
function baseOf(token) {
  const parts = splitVariants(token);
  const utility = parts[parts.length - 1].replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
  return { variants: parts.slice(0, -1), utility };
}

/**
 * What a class token is when it is physical: `{ utility, advice }`, else null.
 * `siblings` are the other tokens of the same string: a physical class with an
 * `rtl:`/`ltr:` counterpart of its kind there is a deliberate pair.
 */
export function physicalUtility(token, siblings = []) {
  // `:dir()` is compiled to `:lang()` for older browsers (Tailwind's floor is
  // Chrome 111; `:dir()` is 120), and `:lang()` matches the language of the
  // page, not the direction of the text: a rule that was meant for an Arabic
  // list on an English page never applies. Use `[dir=rtl]` (the app writes
  // `dir` on what it lays out) or Tailwind's `rtl:` variant.
  if (/:dir\(/.test(token)) {
    return {
      utility: ':dir()',
      advice:
        '[dir=rtl] / [dir=ltr] attribute selectors, or rtl: (the CSS build rewrites :dir() to :lang())',
    };
  }
  const { variants, utility } = baseOf(token);
  // Prose that happens to start like one: 'right-to-left', 'left-to-right'.
  if (/^(?:left|right)-to-(?:left|right)$/.test(utility)) return null;
  if (variants.includes('rtl') || variants.includes('ltr')) return null;
  // No movement at all: the same in both directions.
  if (/^translate-x-0$/.test(utility)) return null;
  let advice = null;
  if (PHYSICAL_GRADIENT.test(utility))
    advice = 'an rtl: counterpart with the gradient turned round';
  else if (ARBITRARY_PROPERTY.test(utility))
    advice = 'the logical CSS property in the arbitrary value';
  else {
    for (const [pattern, use] of UTILITIES) {
      if (pattern.test(utility)) {
        advice = use;
        break;
      }
    }
  }
  if (!advice) return null;
  // translate-x, an origin, a background or object position and a gradient are
  // deliberate when the same string has an `rtl:`/`ltr:` counterpart of that kind.
  const family = PHYSICAL_GRADIENT.test(utility)
    ? 'gradient'
    : utility.match(/^(translate-x|origin|bg|object)/)?.[1];
  if (family) {
    const paired = siblings.some((sibling) => {
      const { variants: v, utility: u } = baseOf(sibling);
      if (!(v.includes('rtl') || v.includes('ltr'))) return false;
      return family === 'gradient' ? PHYSICAL_GRADIENT.test(u) : u.startsWith(family);
    });
    if (paired) return null;
  }
  return { utility, advice };
}

/** A token the checker should even consider: a class-like word (no spaces, no quote). */
const CLASS_LIKE = /^[!\w\-[\]()&>*:.,%/#=^~'"$@+|]+$/;

// Icons ---------------------------------------------------------------------

/** lucide-react icons whose meaning is a direction: they mirror in right-to-left. */
export const DIRECTION_ICONS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowBigLeft',
  'ArrowBigRight',
  'ArrowUpLeft',
  'ArrowUpRight',
  'ArrowDownLeft',
  'ArrowDownRight',
  'ArrowLeftToLine',
  'ArrowRightToLine',
  'ChevronLeft',
  'ChevronRight',
  'ChevronsLeft',
  'ChevronsRight',
  'ChevronFirst',
  'ChevronLast',
  'CornerDownLeft',
  'CornerDownRight',
  'CornerUpLeft',
  'CornerUpRight',
  'CornerLeftDown',
  'CornerLeftUp',
  'CornerRightDown',
  'CornerRightUp',
  'Undo',
  'Undo2',
  'Redo',
  'Redo2',
  'Send',
  'SendHorizontal',
  'Reply',
  'ReplyAll',
  'Forward',
  'LogIn',
  'LogOut',
  'PanelLeft',
  'PanelLeftClose',
  'PanelLeftOpen',
  'PanelRight',
  'PanelRightClose',
  'PanelRightOpen',
  'ExternalLink',
  'FolderInput',
  'FolderOutput',
  'IndentIncrease',
  'IndentDecrease',
  'ListIndentIncrease',
  'ListIndentDecrease',
  'SkipBack',
  'SkipForward',
]);

const iconName = (name) => name.replace(/Icon$/, '');

// Style objects -------------------------------------------------------------

const STYLE_PROPERTIES = new Map(
  [
    ['marginLeft', 'marginInlineStart'],
    ['marginRight', 'marginInlineEnd'],
    ['paddingLeft', 'paddingInlineStart'],
    ['paddingRight', 'paddingInlineEnd'],
    ['borderLeft', 'borderInlineStart'],
    ['borderRight', 'borderInlineEnd'],
    ['borderLeftWidth', 'borderInlineStartWidth'],
    ['borderRightWidth', 'borderInlineEndWidth'],
    ['borderLeftColor', 'borderInlineStartColor'],
    ['borderRightColor', 'borderInlineEndColor'],
    ['borderLeftStyle', 'borderInlineStartStyle'],
    ['borderRightStyle', 'borderInlineEndStyle'],
    ['borderTopLeftRadius', 'borderStartStartRadius'],
    ['borderTopRightRadius', 'borderStartEndRadius'],
    ['borderBottomLeftRadius', 'borderEndStartRadius'],
    ['borderBottomRightRadius', 'borderEndEndRadius'],
    ['scrollMarginLeft', 'scrollMarginInlineStart'],
    ['scrollMarginRight', 'scrollMarginInlineEnd'],
    ['scrollPaddingLeft', 'scrollPaddingInlineStart'],
    ['scrollPaddingRight', 'scrollPaddingInlineEnd'],
  ].map(([physical, logical]) => [physical, logical]),
);

function propertyName(node) {
  const { name } = node;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function isInsideStyleAttribute(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) return current.name.getText() === 'style';
    if (ts.isArrowFunction(current) || ts.isFunctionDeclaration(current)) return false;
  }
  return false;
}

// Finding them --------------------------------------------------------------

/** Every physical use in one .ts/.tsx file: `{ line, utility, advice }`. */
export function findInSource(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX,
  );
  const found = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  const inspectText = (text, node) => {
    const tokens = text.split(/\s+/).filter((token) => token && CLASS_LIKE.test(token));
    for (const token of tokens) {
      const hit = physicalUtility(token, tokens);
      if (hit) found.push({ line: lineOf(node), ...hit });
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // An import path or a type string is not a class list.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        inspectText(node.text, node);
      }
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      inspectText(node.text, node);
    } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText();
      if (DIRECTION_ICONS.has(iconName(tag))) {
        const className = node.attributes.properties.find(
          (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'className',
        );
        if (!className || !/\brtl:/.test(className.getText())) {
          found.push({
            line: lineOf(node),
            utility: `<${tag}>`,
            advice:
              'className="rtl:-scale-x-100" (or rtl:rotate-180 where it also turns): it points somewhere',
          });
        }
      }
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = propertyName(node);
      if (name && STYLE_PROPERTIES.has(name)) {
        found.push({
          line: lineOf(node),
          utility: name,
          advice: STYLE_PROPERTIES.get(name),
        });
      } else if ((name === 'left' || name === 'right') && isInsideStyleAttribute(node)) {
        found.push({
          line: lineOf(node),
          utility: name,
          advice: name === 'left' ? 'insetInlineStart' : 'insetInlineEnd',
        });
      } else if (
        ts.isPropertyAssignment(node) &&
        (name === 'textAlign' || name === 'float' || name === 'clear') &&
        ts.isStringLiteralLike(node.initializer) &&
        (node.initializer.text === 'left' || node.initializer.text === 'right')
      ) {
        found.push({
          line: lineOf(node),
          utility: `${name}: ${node.initializer.text}`,
          advice: 'start / end',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const CSS_PROPERTIES =
  /(?:^|[\s;{])(margin-(?:left|right)|padding-(?:left|right)|border-(?:left|right)(?:-(?:width|color|style))?|border-(?:top|bottom)-(?:left|right)-radius|scroll-(?:margin|padding)-(?:left|right)|left|right)\s*:/g;
const CSS_VALUES = /(?:^|[\s;{])(text-align|float|clear)\s*:\s*(left|right)\b/g;

/** Every physical use in one .css file. Comments are skipped; `@apply` lines are read as classes. */
export function findInCss(content) {
  const found = [];
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  );
  withoutComments.split('\n').forEach((text, index) => {
    const line = index + 1;
    for (const match of text.matchAll(CSS_PROPERTIES)) {
      found.push({
        line,
        utility: match[1],
        advice: 'the logical property (…-inline-start / -end)',
      });
    }
    if (/:dir\(/.test(text)) {
      found.push({
        line,
        utility: ':dir()',
        advice: '[dir=rtl] attribute selectors (the CSS build rewrites :dir() to :lang())',
      });
    }
    for (const match of text.matchAll(CSS_VALUES)) {
      found.push({ line, utility: `${match[1]}: ${match[2]}`, advice: 'start / end' });
    }
    const apply = text.match(/@apply\s+(.*?);?\s*$/);
    if (apply) {
      const tokens = apply[1].split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        const hit = physicalUtility(token, tokens);
        if (hit) found.push({ line, ...hit });
      }
    }
  });
  return found;
}

/** Everything physical under apps/web/src: `{ file, line, utility, advice }`. */
export function scan(root) {
  const found = [];
  for (const path of walk(join(root, WEB_SRC), ['.ts', '.tsx', '.css'])) {
    const file = posix(relative(root, path));
    const content = readFileSync(path, 'utf8');
    const hits = file.endsWith('.css') ? findInCss(content) : findInSource(file, content);
    for (const hit of hits) found.push({ file, ...hit });
  }
  return found;
}

/** Problems with the code against the allowlist (counted per file and utility). */
export function checkLogicalCss(root) {
  const problems = [];
  const allowPath = join(root, ALLOWLIST);
  const entries = existsSync(allowPath)
    ? (JSON.parse(readFileSync(allowPath, 'utf8')).entries ?? [])
    : [];
  const allowed = new Map();
  for (const entry of entries) {
    if (
      !entry.file ||
      !entry.utility ||
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      !String(entry.reason ?? '').trim()
    ) {
      problems.push(
        `${ALLOWLIST}: every entry needs file, utility, a count of 1 or more, and a reason`,
      );
    } else allowed.set(`${entry.file}\u0000${entry.utility}`, entry);
  }

  const counts = new Map();
  const first = new Map();
  const advice = new Map();
  for (const hit of scan(root)) {
    const key = `${hit.file}\u0000${hit.utility}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!first.has(key)) first.set(key, hit.line);
    advice.set(key, hit.advice);
  }

  for (const [key, count] of counts) {
    const [file, utility] = key.split('\u0000');
    const permitted = allowed.get(key)?.count ?? 0;
    if (count > permitted) {
      problems.push(
        permitted === 0
          ? `${file}:${first.get(key)}: physical \`${utility}\` (mirrors wrongly in right-to-left); use ${advice.get(key)}`
          : `${file}: ${count} uses of \`${utility}\`, ${permitted} allowed in ${ALLOWLIST}; use ${advice.get(key)} for the new one`,
      );
    } else if (count < permitted) {
      problems.push(
        `${ALLOWLIST}: ${file} has ${count} of \`${utility}\` now, not ${permitted}; lower the count (the list only shrinks)`,
      );
    }
  }
  for (const [key, entry] of allowed) {
    if (!counts.has(key)) {
      problems.push(
        `${ALLOWLIST}: \`${entry.utility}\` in ${entry.file} no longer appears; remove its entry`,
      );
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootArgument = process.argv.indexOf('--root');
  const root = rootArgument > 0 ? resolve(process.argv[rootArgument + 1]) : resolve(HERE, '..');
  if (process.argv.includes('--list')) {
    for (const hit of scan(root))
      console.log(`${hit.file}:${hit.line}\t${hit.utility}\t${hit.advice}`);
    process.exit(0);
  }
  const problems = checkLogicalCss(root);
  if (problems.length > 0) {
    console.error(
      `Logical CSS check failed (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log('Logical CSS check passed.');
}

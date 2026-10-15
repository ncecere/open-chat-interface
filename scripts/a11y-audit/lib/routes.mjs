/**
 * The audit's list of routes, and the check that it matches the router.
 *
 * `routes.json` says, for every path in `apps/web/src/router.tsx`, who can reach it (public,
 * end-user, admin) and what the audit needs to open it. A test fails when the router has a
 * path the list lacks, so a new page cannot slip past the audit.
 *
 * The router is read as text rather than imported: it pulls in the whole React app. The
 * reading is strict. A route whose path it cannot read is an error, not a silent omission.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ROUTES_FILE = join(REPO_ROOT, 'scripts', 'a11y-audit', 'routes.json');

export const AUDIENCES = ['public', 'end-user', 'admin'];

/** @returns {Array<{ path: string, audience: string, kind: string, [key: string]: unknown }>} */
export function loadRoutes(file = ROUTES_FILE) {
  return JSON.parse(readFileSync(file, 'utf8')).routes;
}

/** The router's paths that the list does not have. */
export function routesMissingFromList(found, routes) {
  const listed = new Set(routes.map((route) => route.path));
  return found.filter((path) => !listed.has(path));
}

/** Fills `$param` segments from `params`; a parameter with no value is an error. */
export function resolveConcretePath(path, params) {
  return path.replace(/\$(\w+)/g, (_, name) => {
    if (params[name] === undefined) throw new Error(`No value for :${name} in ${path}`);
    return encodeURIComponent(params[name]);
  });
}

/** The source without comments, so an apostrophe in one is not read as a quote. */
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      out += char;
      if (char === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      if (char === "'" || char === '"' || char === '`') quote = char;
      out += char;
    }
  }
  return out;
}

/** The index just past the bracket that closes the one at `open`, skipping quoted text. */
function closing(source, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (pairs[char]) stack.push(pairs[char]);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error('Unbalanced brackets in router source');
}

/** The text of an object or array literal at depth 1, with nested literals blanked out. */
function topLevel(text) {
  let depth = 0;
  let quote = null;
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      if (depth === 1) out += char;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      if (depth === 1) out += char;
    } else if ('{[('.includes(char)) {
      depth += 1;
      if (depth === 1) out += char;
    } else if ('}])'.includes(char)) {
      depth -= 1;
      if (depth === 0) out += char;
    } else if (depth === 1) out += char;
  }
  return out;
}

function stringLiterals(text) {
  return [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/** `export const NAME = '/value'` anywhere under the web app and the shared package. */
function findConstant(name, repoRoot) {
  const pattern = new RegExp(`export const ${name}\\s*=\\s*'([^']+)'`);
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (/\.(ts|tsx)$/.test(entry)) {
        const match = pattern.exec(readFileSync(full, 'utf8'));
        if (match) return match[1];
      }
    }
    return null;
  };
  for (const root of ['apps/web/src', 'packages/shared/src']) {
    const found = walk(join(repoRoot, root));
    if (found) return found;
  }
  return null;
}

/** The `path: '…'` of each object in `const NAME = [ { path: … }, … ]`. */
function arrayItemPaths(source, name) {
  const declaration = new RegExp(`const ${name}\\b[^=]*=\\s*\\[`).exec(source);
  if (!declaration) throw new Error(`Cannot read the path of a route built from ${name}`);
  const open = declaration.index + declaration[0].length - 1;
  const body = source.slice(open, closing(source, open));
  const paths = [];
  for (const match of body.matchAll(/\{[^{}]*?\bpath:\s*'([^']+)'/g)) paths.push(match[1]);
  return paths;
}

/**
 * Every path `router.tsx` declares: `createRoute({ path })` with a literal or a named
 * constant, `redirectRoute('/path', …)`, the settings tabs, and the retired settings pages.
 * Layout routes (`id` only) have no path.
 *
 * @param {string} source
 * @param {string} repoRoot where to look for named constants
 * @param {Record<string, string>} [constants] values for constants, instead of the repo's
 */
export function extractRouterPaths(rawSource, repoRoot, constants = {}) {
  const source = stripComments(rawSource);
  const paths = new Set();

  for (const match of source.matchAll(/\bredirectRoute\(\s*'([^']+)'/g)) paths.add(match[1]);

  for (const match of source.matchAll(/\bcreateRoute\(/g)) {
    const open = source.indexOf('{', match.index);
    const body = topLevel(source.slice(open, closing(source, open)));
    const before = source.slice(0, match.index);

    const pathProperty = /(?:^|[,{]\s*)path:\s*([^,}]+)/.exec(body);
    if (pathProperty) {
      const expression = pathProperty[1].trim();
      const literal = /^'([^']+)'$/.exec(expression);
      if (literal) {
        paths.add(literal[1]);
        continue;
      }
      if (/^[A-Z][A-Z0-9_]*$/.test(expression)) {
        const value = constants[expression] ?? findConstant(expression, repoRoot);
        if (!value) throw new Error(`Cannot read the path of a route: ${expression} has no value`);
        paths.add(value);
        continue;
      }
      const member = /^(\w+)\.path$/.exec(expression);
      if (member) {
        const mapped = [
          ...before.matchAll(new RegExp(`(\\w+)\\.map\\(\\(\\s*${member[1]}\\s*\\)\\s*=>`, 'g')),
        ].at(-1);
        if (!mapped) throw new Error(`Cannot read the path of a route: ${expression}`);
        for (const path of arrayItemPaths(source, mapped[1])) paths.add(path);
        continue;
      }
      throw new Error(`Cannot read the path of a route: path: ${expression}`);
    }

    if (/(?:^|[,{]\s*)path\s*(?=[,}])/.test(body)) {
      // `path` shorthand: either inside `.map((path) => createRoute(…))` over a list of
      // paths, or inside the redirectRoute helper, whose call sites are read above.
      const mapped = [...before.matchAll(/\.map\(\(\s*path\s*\)\s*=>\s*$/g)].at(-1);
      const helper = [
        ...before.matchAll(/function\s+\w+\s*(?:<[^>]*>)?\s*\(\s*path\b[^)]*\)\s*\{\s*return\s*$/g),
      ].at(-1);
      if (mapped) {
        const receiver = before.slice(0, mapped.index);
        if (receiver.endsWith(']')) {
          const start = receiver.lastIndexOf('[');
          for (const path of stringLiterals(receiver.slice(start))) paths.add(path);
        } else {
          const name = /(\w+)$/.exec(receiver)?.[1];
          const declared =
            name && new RegExp(`const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
          if (!declared)
            throw new Error('Cannot read the path of a route built with .map((path) => …)');
          for (const path of stringLiterals(declared[1])) paths.add(path);
        }
        continue;
      }
      if (helper) continue;
      throw new Error('Cannot read the path of a route: path shorthand outside a known helper');
    }

    if (!/(?:^|[,{]\s*)id:/.test(body))
      throw new Error('Cannot read the path of a route: no path and no id');
  }

  return [...paths].sort();
}

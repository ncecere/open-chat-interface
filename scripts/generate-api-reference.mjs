#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Builds the API route table from the routes themselves.
 *
 * Written rather than maintained by hand because a twenty-eight file reference
 * is the fastest part of any documentation to go stale, and a table that
 * disagrees with the code is worse than no table.
 *
 * This reads route registrations textually rather than importing the modules:
 * importing would need a database, a Redis connection, and a decryption key
 * simply to list paths.
 */
const API_ROOT = 'apps/api/src/routes';
const OUTPUT = 'docs/dev/api-reference.md';

/** `const userRoutes = new Hono<AppBindings>()` — a router this file creates. */
const ROUTER = /(?:const|let)\s+(\w+)\s*=\s*new Hono\b/g;

/** `import { healthRoutes as adminHealthRoutes } from './health.js'` */
const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g;

/** `adminRoutes.route('/audit', auditRoutes)` — a sub-router and its prefix. */
const MOUNT = /(\w+)\.route\(\s*'([^']+)'\s*,\s*(\w+)/g;

/** `userRoutes.get('/:id', ...)` — a handler and its method. */
const HANDLER = /(\w+)\.(get|post|patch|put|delete|on)\(\s*(?:\[[^\]]*\]\s*,\s*)?'([^']+)'/g;

/**
 * The comment immediately above a handler, used as its description.
 *
 * Only when it is *immediately* above: a block separated by other statements
 * usually documents a schema or a helper, and attributing it to the route
 * produces a table that reads plausibly and says the wrong thing.
 */
function describedAt(source, index) {
  // Walk back over the whitespace directly before the handler; anything more
  // than a blank line means the comment belongs to something else.
  let cursor = index;
  let newlines = 0;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? '')) {
    if (source[cursor - 1] === '\n') newlines += 1;
    cursor -= 1;
  }
  if (newlines > 1) return '';

  const before = source.slice(0, cursor);
  if (!before.endsWith('*/')) return '';

  const opened = before.lastIndexOf('/**');
  if (opened === -1) return '';

  // The first sentence of the first paragraph, which may wrap over lines.
  const lines = before
    .slice(opened + 3, before.length - 2)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim());
  const start = lines.findIndex(Boolean);
  if (start === -1) return '';
  const end = lines.indexOf('', start);
  const paragraph = lines.slice(start, end === -1 ? undefined : end).join(' ');
  const sentence = paragraph.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? paragraph;
  return sentence.replaceAll('|', '\\|');
}

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) files.push(full);
  }
  return files;
}

const files = await collect(API_ROOT);
/** Child router id -> { prefix, parent router id }. Ids are `file#name`. */
const mounts = new Map();
const handlers = [];

/**
 * Routers are identified by file and name, not by name alone: two files may
 * export a router with the same name (the public and admin `healthRoutes`).
 * Only routers created with `new Hono` count, so `.get('content-type')` on a
 * header map or `.on('close')` on a stream are not mistaken for routes.
 */
for (const file of files) {
  const source = await readFile(file, 'utf8');
  const routers = new Set([...source.matchAll(ROUTER)].map((match) => match[1]));

  const imported = new Map();
  for (const match of source.matchAll(IMPORT)) {
    const target = path.join(path.dirname(file), match[2].replace(/\.js$/, '.ts'));
    for (const specifier of match[1].split(',')) {
      const [name, local = name] = specifier
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      if (name) imported.set(local, `${target}#${name}`);
    }
  }

  for (const match of source.matchAll(MOUNT)) {
    if (!routers.has(match[1])) continue;
    const child = imported.get(match[3]) ?? `${file}#${match[3]}`;
    mounts.set(child, { prefix: match[2], parent: `${file}#${match[1]}` });
  }

  for (const match of source.matchAll(HANDLER)) {
    if (!routers.has(match[1])) continue;
    handlers.push({
      router: `${file}#${match[1]}`,
      method: match[2] === 'on' ? 'GET/POST' : match[2].toUpperCase(),
      routePath: match[3],
      file: path.relative('apps/api/src', file),
      description: describedAt(source, match.index ?? 0),
    });
  }
}

/** Walks the mount chain so a nested router reports its full path. */
function fullPath(router, routePath) {
  const segments = [];
  let current = router;

  for (let depth = 0; depth < 8; depth += 1) {
    const mount = mounts.get(current);
    if (!mount) break;
    segments.unshift(mount.prefix);
    current = mount.parent;
  }

  const joined = `${segments.join('')}${routePath === '/' ? '' : routePath}`;
  return `/api${joined || '/'}`.replace(/\/+/g, '/');
}

const grouped = new Map();
for (const handler of handlers) {
  const list = grouped.get(handler.file) ?? [];
  list.push({ ...handler, path: fullPath(handler.router, handler.routePath) });
  grouped.set(handler.file, list);
}

const lines = [
  '# API reference',
  '',
  '<!-- Generated by scripts/generate-api-reference.mjs. Do not edit by hand. -->',
  '',
  'Every route the API registers, grouped by the file that defines it.',
  '',
  'Administrative routes require the `admin` role; an `auditor` may call the',
  'read-only ones. See [identity and access](../admin/identity.md).',
  '',
  `Generated from ${files.length} route files.`,
  '',
];

for (const [file, routes] of [...grouped.entries()].sort()) {
  lines.push(`## \`${file}\``, '', '| Method | Path | Purpose |', '| --- | --- | --- |');

  for (const route of routes.sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push(`| ${route.method} | \`${route.path}\` | ${route.description || '—'} |`);
  }
  lines.push('');
}

await writeFile(OUTPUT, `${lines.join('\n')}\n`);
console.log(`Wrote ${OUTPUT}: ${handlers.length} routes across ${grouped.size} files.`);

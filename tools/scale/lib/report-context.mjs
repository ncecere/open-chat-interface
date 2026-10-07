// Scale report command line (parsed at import) and the run directory's JSON files.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phase: { type: 'string', default: 'main' },
    since: { type: 'string' },
    name: { type: 'string', default: 'before' },
    'run-dir': { type: 'string', default: '/results' },
    'database-url': { type: 'string' },
  },
});
export const command = positionals[0];
export const runDir = args['run-dir'];

export function readJson(name) {
  const path = resolve(runDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writeJson(name, value) {
  writeFileSync(resolve(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

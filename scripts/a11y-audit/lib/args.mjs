/**
 * `pnpm a11y:audit [--base-url URL] [--out DIR] [--matrix smoke|standard|full] …`
 */

import { join } from 'node:path';
import { REPO_ROOT } from './routes.mjs';

export const DEFAULTS = {
  baseUrl: 'http://localhost:5173',
  out: join(REPO_ROOT, 'docs', 'accessibility'),
  matrix: 'standard',
  roles: ['anonymous', 'admin', 'user', 'restricted'],
  themes: ['light', 'dark'],
  accents: ['neutral', 'blue', 'violet', 'emerald'],
  views: ['1280', '768', '320', 'zoom400', 'text200', 'reduce'],
  languages: ['en', 'ar-XB', 'ar'],
  concurrency: 3,
};

const LISTS = new Set(['roles', 'themes', 'accents', 'views', 'languages']);
const FLAGS = {
  '--base-url': 'baseUrl',
  '--out': 'out',
  '--matrix': 'matrix',
  '--roles': 'roles',
  '--themes': 'themes',
  '--accents': 'accents',
  '--views': 'views',
  '--languages': 'languages',
  '--routes': 'routes',
  '--concurrency': 'concurrency',
  '--only': 'only',
};
const SWITCHES = { '--no-walkthroughs': 'noWalkthroughs', '--help': 'help', '-h': 'help' };

export const USAGE = `Usage: pnpm a11y:audit [options]

Runs the accessibility audit against a seeded, running instance and writes evidence.json.
Environment: E2E_BASE_URL (or --base-url), E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD.

  --base-url URL       the instance (default $E2E_BASE_URL, else ${DEFAULTS.baseUrl})
  --out DIR            where evidence.json is written (default docs/accessibility)
  --matrix PROFILE     smoke | standard (default) | full; see scripts/a11y-audit/lib/matrix.mjs
  --roles LIST         ${DEFAULTS.roles.join(',')}
  --themes LIST        ${DEFAULTS.themes.join(',')}
  --accents LIST       ${DEFAULTS.accents.join(',')}
  --views LIST         ${DEFAULTS.views.join(',')}
  --languages LIST     ${DEFAULTS.languages.join(',')}  (en-XA and ar-XB are pseudo-locales and need a
                       build made with VITE_OCI_PSEUDO_LOCALES=1; a language that is not
                       reachable is recorded as skipped, not silently dropped)
  --routes PATTERN     only routes whose path matches this regular expression
  --only LIST          comma list of: pages, walkthroughs, global
  --no-walkthroughs    skip the keyboard walkthroughs
  --concurrency N      browser contexts at once (default ${DEFAULTS.concurrency})
`;

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = {}) {
  const options = { ...DEFAULTS, baseUrl: env.E2E_BASE_URL ?? DEFAULTS.baseUrl };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (SWITCHES[name]) {
      options[SWITCHES[name]] = true;
      continue;
    }
    const key = FLAGS[name];
    if (!key) throw new Error(`Unknown option ${name}\n\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (LISTS.has(key))
      options[key] = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    else if (key === 'concurrency') {
      options[key] = Number(value);
      if (!Number.isInteger(options[key]) || options[key] < 1)
        throw new Error('--concurrency needs a whole number of at least 1');
    } else if (key === 'only') options.only = value.split(',').map((part) => part.trim());
    else options[key] = value;
  }
  options.baseUrl = options.baseUrl.replace(/\/+$/, '');
  try {
    new URL(options.baseUrl);
  } catch {
    throw new Error(`--base-url "${options.baseUrl}" is not a URL`);
  }
  return options;
}

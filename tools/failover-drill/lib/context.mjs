// Drill state shared by the failover drill: paths, constants, options (parsed from argv,
// --help handled here at import), the output directory, compose env and the timeline log.

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../upgrade-test/lib.mjs';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(TOOL_DIR, '../..');
export const PROJECT = 'oci-failover';
export const COMPOSE_FILE = join(TOOL_DIR, 'compose.yaml');
export const PATRONI_CONFIG = '/home/postgres/postgres.yml';
export const SUPERUSER_URL = 'postgresql://postgres:failover-drill-superuser@haproxy:5432';
/** Stored on a reply saved as interrupted (apps/api/src/services/chat/run-recovery.ts). */
export const INTERRUPTED = 'This reply was interrupted';
/** Recorded on a job run cut short by a lost lock (apps/api/src/services/jobs/runner.ts). */
export const LOST_LOCK = 'Stopped early: the job lost its lock';

const spec = {
  'api-image': { default: '' },
  'web-image': { default: '' },
  out: {
    default: resolve(TOOL_DIR, 'out', new Date().toISOString().replace(/[:.]/g, '-')),
  },
  port: { type: 'number', default: 18580 },
  people: { type: 'number', default: 8 },
  vus: { type: 'number', default: 6 },
  'think-ms': { type: 'number', default: 300 },
  'send-every': { type: 'number', default: 1 },
  'baseline-seconds': { type: 'number', default: 20 },
  'after-seconds': { type: 'number', default: 40 },
  /** Retryable failures are accepted from the failover until this long after HAProxy switched. */
  'window-seconds': { type: 'number', default: 30 },
  'import-conversations': { type: 'number', default: 5000 },
  /** How many times to move the primary, a minute apart (the first mid-job). */
  failovers: { type: 'number', default: 1 },
  'settle-seconds': { type: 'number', default: 240 },
  /** Kill the Redis primary (under Sentinel) instead of moving the PostgreSQL one. */
  redis: { type: 'boolean', default: false },
  /** With --redis: every Nth reply is read for --cut-after-ms only, then resumed. */
  'cut-every': { type: 'number', default: 3 },
  'cut-after-ms': { type: 'number', default: 1200 },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

export const options = parseArgs(process.argv.slice(2), spec);
if (options.help) {
  console.log(
    `Usage: node tools/failover-drill/run.mjs [options]\n\n${Object.entries(spec)
      .map(([k, v]) => `  --${k}${v.type === 'boolean' ? '' : ' <value>'}  (default: ${v.default})`)
      .join('\n')}`,
  );
  process.exit(0);
}

export const outDir = resolve(options.out);
mkdirSync(outDir, { recursive: true });
export const base = `http://127.0.0.1:${options.port}`;
export const env = { OCI_DRILL_PORT: String(options.port) };
export const SENTINELS = ['sentinel-1', 'sentinel-2', 'sentinel-3'];
if (options.redis)
  Object.assign(env, {
    OCI_DRILL_REDIS_URL: '',
    OCI_DRILL_REDIS_SENTINELS: SENTINELS.map((name) => `${name}:26379`).join(','),
  });
export const timeline = [];
export const startedAt = Date.now();
export function log(what) {
  const at = new Date().toISOString();
  timeline.push({ at, what });
  console.log(`[failover-drill ${at.slice(11, 19)}] ${what}`);
}

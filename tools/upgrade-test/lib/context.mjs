// Run state shared by the upgrade test: constants, options (parsed from argv, --help
// handled here at import), the output directory, the timeline log and compose env.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CASES } from '../inject.mjs';
import { parseArgs, TOOL_DIR } from '../lib.mjs';

export const REGISTRY = 'ghcr.io/ncecere/open-chat-interface';
export const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
/** The first release whose API drains on shutdown (design item 13). */
export const FIRST_DRAINING = 'v0.11.0';
/** The first release that reads versioned secrets (`oci:v1:<key id>:`). */
export const FIRST_VERSIONED_SECRETS = 'v0.11.0';
/** The migrators' advisory lock keys (packages/db/src/migrator.ts, post-migrator.ts). */
export const MIGRATION_LOCK = 8374920115573001n;
export const POST_MIGRATION_LOCK = 8374920115573002n;

const spec = {
  from: { default: '' },
  'to-api': { default: '' },
  'to-web': { default: '' },
  inject: { default: '' },
  out: {
    default: resolve(TOOL_DIR, 'out', new Date().toISOString().replace(/[:.]/g, '-')),
  },
  port: { type: 'number', default: 18480 },
  people: { type: 'number', default: 40 },
  threads: { type: 'number', default: 10_000 },
  'messages-per-thread': { type: 'number', default: 30 },
  /** Usage events seeded (one per seeded reply first, then spread over 60 days). */
  'usage-events': { type: 'number', default: 240_000 },
  vus: { type: 'number', default: 6 },
  'think-ms': { type: 'number', default: 400 },
  'send-every': { type: 'number', default: 2 },
  'baseline-seconds': { type: 'number', default: 20 },
  'settle-seconds': { type: 'number', default: 15 },
  'cooldown-seconds': { type: 'number', default: 10 },
  'stop-timeout': { type: 'number', default: 30 },
  'stub-chunks': { type: 'number', default: 40 },
  'stub-chunk-ms': { type: 'number', default: 100 },
  'p99-ms': { type: 'number', default: 2000 },
  'max-ms': { type: 'number', default: 5000 },
  'lock-wait-ms': { type: 'number', default: 3000 },
  'request-timeout-ms': { type: 'number', default: 30_000 },
  /**
   * Report replies cut off by a stopping replica instead of failing. Off since
   * design item 13 (draining on shutdown). A replica running a release from
   * before it (FROM older than v0.11.0) cannot drain, so the replies it cuts
   * are always reported, and checked for recovery, rather than failed.
   */
  'allow-cut-replies': { type: 'boolean', default: false },
  /**
   * Report failures and latency from SIGTERM of an API replica until
   * --gap-tail-ms after it exited instead of failing. Off since item 13; the
   * windows of replicas on a release from before it are always reported.
   */
  'allow-shutdown-gaps': { type: 'boolean', default: false },
  'gap-tail-ms': { type: 'number', default: 15_000 },
  'replace-web': { type: 'boolean', default: true },
  /** After the upgrade, restart each API replica on TO, as the next upgrade will. */
  'restart-api': { type: 'boolean', default: true },
  /** Run the post-deploy phase (`migrate --post`) once every replica runs TO. */
  'post-deploy': { type: 'boolean', default: true },
  /**
   * Test-only background migrations TO runs (comma-separated; empty for none):
   * the default rewrites every seeded message in place, a batch at a time.
   */
  background: { default: 'oci-test.rewrite-messages-in-place' },
  'background-timeout-seconds': { type: 'number', default: 300 },
  'expect-fail': { type: 'boolean', default: false },
  /** Pull FROM (and --to-*) images even when a local copy exists. */
  pull: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
};

export const options = parseArgs(process.argv.slice(2), spec);
if (options.help) {
  console.log(
    `Usage: node tools/upgrade-test/run.mjs [options]\n\n${Object.entries(spec)
      .map(([k, v]) => `  --${k}${v.type === 'boolean' ? '' : ' <value>'}  (default: ${v.default})`)
      .join('\n')}\n\nInjected cases: ${Object.keys(CASES).join(', ')}`,
  );
  process.exit(0);
}

export const outDir = resolve(options.out);
mkdirSync(outDir, { recursive: true });
export const startedAt = Date.now();
export const timeline = [];
export function log(what) {
  const at = new Date().toISOString();
  timeline.push({ at, what });
  console.log(`[upgrade-test ${at.slice(11, 19)}] ${what}`);
}

const portA = options.port;
const portB = options.port + 1;
export const bases = [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`];
export const origin = bases[0];
export const env = {
  OCI_UPGRADE_PORT: String(portA),
  OCI_UPGRADE_PORT2: String(portB),
  OCI_UPGRADE_STOP_GRACE: `${options['stop-timeout']}s`,
  OCI_UPGRADE_STUB_CHUNKS: String(options['stub-chunks']),
  OCI_UPGRADE_STUB_CHUNK_MS: String(options['stub-chunk-ms']),
  OCI_UPGRADE_TEST_BACKGROUND: options.background,
};

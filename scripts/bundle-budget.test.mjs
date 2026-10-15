import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// apps/web/scripts/check-route-chunks.mjs also holds the initial JavaScript to a
// size budget (v0.14, #397): the baseline plus the growth the translation
// framework may add. These run it on a small made-up build.

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../apps/web/scripts/check-route-chunks.mjs',
);
const made = [];

/** A build whose entry chunk is `bytes` of poorly compressible text. */
function build(bytes) {
  const dist = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  made.push(dist);
  mkdirSync(join(dist, '.vite'));
  mkdirSync(join(dist, 'assets'));
  let state = 12345;
  let text = '';
  while (text.length < bytes) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += state.toString(36);
  }
  const code = text.slice(0, bytes);
  writeFileSync(join(dist, 'assets/index.js'), code);
  writeFileSync(
    join(dist, 'assets/index.js.map'),
    JSON.stringify({ sources: ['../../src/main.tsx'] }),
  );
  writeFileSync(
    join(dist, '.vite/manifest.json'),
    JSON.stringify({ 'index.html': { file: 'assets/index.js', src: 'index.html', isEntry: true } }),
  );
  return { dist, gzip: gzipSync(code).length };
}

function budget(baselineGzipBytes, allowedGrowthGzipBytes) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-file-'));
  made.push(dir);
  const path = join(dir, 'budget.json');
  writeFileSync(
    path,
    JSON.stringify({ baseline: 'v0.13.1', baselineGzipBytes, allowedGrowthGzipBytes }),
  );
  return path;
}

const run = (dist, budgetPath) =>
  spawnSync('node', [SCRIPT, dist, budgetPath], { encoding: 'utf8' });

after(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

describe('the initial JavaScript budget', () => {
  it('passes at the baseline and within the allowed growth, and says how much is used', () => {
    const { dist, gzip } = build(20_000);
    const atBaseline = run(dist, budget(gzip, 8_192));
    assert.equal(atBaseline.status, 0, atBaseline.stderr);
    assert.match(atBaseline.stdout, /budget passed: \+0 of 8192/);
    const within = run(dist, budget(gzip - 5_000, 8_192));
    assert.equal(within.status, 0, within.stderr);
    assert.match(within.stdout, /\+5000 of 8192/);
  });

  it('passes exactly at the limit', () => {
    const { dist, gzip } = build(20_000);
    assert.equal(run(dist, budget(gzip - 8_192, 8_192)).status, 0);
  });

  it('fails one byte over, and says what to do', () => {
    const { dist, gzip } = build(20_000);
    const result = run(dist, budget(gzip - 8_193, 8_192));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /8193 over the v0\.13\.1 baseline/);
    assert.match(result.stderr, /Load it lazily/);
  });

  it('is the committed budget that the repository holds: v0.13.1 plus 8 kB', async () => {
    const { default: committed } = await import('../apps/web/scripts/bundle-budget.json', {
      with: { type: 'json' },
    });
    assert.equal(committed.baseline, 'v0.13.1');
    assert.equal(committed.allowedGrowthGzipBytes, 8_192);
    assert.ok(committed.baselineGzipBytes > 300_000);
  });
});

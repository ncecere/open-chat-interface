import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Requires an already authenticated, isolated agent-browser session with the
// companion init-script installed. Warm-cache desktop comparisons, not a load test.
const [metadataPath, session] = process.argv.slice(2);
assert(
  metadataPath && session,
  'Usage: node run-browser-performance.mjs metadata.json session-name',
);
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
assert.notEqual(session, 'default', 'Use an isolated, named browser session');
assert.equal(metadata.urls.api, 'http://127.0.0.1:4180');
assert.equal(metadata.urls.baseline, 'http://127.0.0.1:4179');
assert.equal(metadata.urls.candidate, 'http://127.0.0.1:4178');
const output = mkdtempSync(join(tmpdir(), 'oci-browser-results-'));
const draft = 'nextquestionwhiletheanswerstreams';
function browser(...args) {
  const result = JSON.parse(
    execFileSync('agent-browser', ['--session', session, '--json', ...args], {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  if (Array.isArray(result)) {
    assert(
      result.every((item) => item.success),
      'Browser batch failed',
    );
    return result;
  }
  assert(result.success, result.error ?? 'Browser command failed');
  return result.data?.result ?? result.data;
}
const wait = (condition) => browser('wait', '--fn', condition);
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? null;
const rows = [];

// Prime both origins with an unused identical history, including Markdown/code
// assets. The smoke-test thread (history-01) is intentionally excluded below.
for (const variant of ['candidate', 'baseline']) {
  browser('open', metadata.urls[variant] + metadata.scenarios[11].path);
  wait(
    'document.querySelectorAll("article").length === 100 && Boolean(window.__ociPerformance?.modelReadyAt)',
  );
}
for (let trial = 0; trial < 10; trial++) {
  // Alternate which variant leads each pair to reduce order bias.
  const variant = (trial + Math.floor(trial / 2)) % 2 === 0 ? 'baseline' : 'candidate';
  const scenario = metadata.scenarios[trial + 1];
  const traced = trial < 2;
  if (traced)
    browser('profiler', 'start', '--categories', 'devtools.timeline,v8.execute,blink.user_timing');
  browser('open', metadata.urls[variant] + scenario.path);
  wait(
    'document.querySelectorAll("article").length === 100 && Boolean(window.__ociPerformance?.modelReadyAt)',
  );
  browser('fill', 'textarea[aria-label="Message input"]', 'Benchmark fixed local response.');
  browser('click', 'button[aria-label="Send message"]');
  wait('Boolean(window.__ociPerformance.run?.firstTextAt)');
  browser('focus', 'textarea[aria-label="Message input"]');
  // In this installed CLI, keyboard type emits no keydown events. Real press
  // events are verified isTrusted by the probe; batch avoids CLI startup per key.
  browser('batch', '--bail', ...[...draft].map((key) => `press ${key}`));
  wait('Boolean(window.__ociPerformance.run?.endedAt)');
  const data = browser(
    'eval',
    `({ ...window.__ociPerformance, draftPreserved: document.querySelector('textarea[aria-label="Message input"]').value === ${JSON.stringify(draft)}, messages: document.querySelectorAll('article').length })`,
  );
  assert(
    data.draftPreserved && data.messages === 102 && data.pageErrors === 0,
    'Browser correctness check failed',
  );
  assert(data.run.renderedCharacters > 10000, 'Long response did not render');
  const keys = data.keys.filter((entry) => entry.duringStream);
  assert(keys.length >= 20, 'Not enough actual key events occurred while streaming');
  const tasks = data.longTasks.filter(
    (entry) => entry.start >= data.run.startedAt && entry.start <= data.run.endedAt,
  );
  const row = {
    trial,
    variant,
    traced,
    composerReadyMs: data.composerReadyAt,
    modelReadyMs: data.modelReadyAt,
    firstTextMs: data.run.firstTextAt - data.run.startedAt,
    streamUiMs: data.run.endedAt - data.run.startedAt,
    keyCount: keys.length,
    keyToFrameP50Ms: quantile(
      keys.map((entry) => entry.keyToFrameMs),
      0.5,
    ),
    keyToFrameP95Ms: quantile(
      keys.map((entry) => entry.keyToFrameMs),
      0.95,
    ),
    keyToFrameMaxMs: Math.max(...keys.map((entry) => entry.keyToFrameMs)),
    longTasks: tasks.length,
    longTaskTotalMs: tasks.reduce((sum, entry) => sum + entry.duration, 0),
    longTaskMaxMs: Math.max(0, ...tasks.map((entry) => entry.duration)),
    renderedCharacters: data.run.renderedCharacters,
    draftPreserved: data.draftPreserved,
  };
  if (traced) browser('profiler', 'stop', join(output, `${variant}-trace.json`));
  writeFileSync(join(output, `trial-${trial}.json`), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  rows.push(row);
  writeFileSync(
    join(output, 'summary.json'),
    JSON.stringify({ cache: 'warm', metadata: metadata.stream, rows }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(row));
}
console.log(`Browser measurement artifacts: ${output}`);

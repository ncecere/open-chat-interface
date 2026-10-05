import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Long conversations in the browser (v0.11, item 21). Opens the fixture's
// 2,000-message conversation in a fresh browser context per trial and
// measures: time until its last reply is in the page, JavaScript heap and DOM
// size once loaded, long tasks while loading, then scroll jank while the
// reader scrolls up with the mouse wheel, and the cost of scrolling all the
// way to the first message. Warm API, cold browser cache, desktop viewport.
//
//   node scripts/run-browser-long-conversation.mjs metadata.json [--label before] [--trials 5] [--gate]
//
// --gate fails (exit 1) when the medians exceed the bounds in GATE below.
const args = process.argv.slice(2);
const [metadataPath] = args;
assert(metadataPath, 'Usage: node run-browser-long-conversation.mjs metadata.json [--gate]');
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index > 0 ? args[index + 1] : fallback;
};
const label = option('--label', 'candidate');
const trials = Number(option('--trials', '5'));
const origin = option('--origin', 'http://127.0.0.1:4178');
const gate = args.includes('--gate');
// Chrome DevTools CPU throttling (4 approximates a mid-range phone); 1 is none.
const throttle = Number(option('--cpu-throttle', '1'));
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
assert.equal(metadata.urls.api, 'http://127.0.0.1:4180');
assert(['http://127.0.0.1:4178', 'http://127.0.0.1:4179'].includes(origin), 'Fixture origin only');
const scenario = metadata.scenarios.find((item) => item.label === 'long-conversation');
assert(scenario, 'The fixture has no long-conversation scenario');

/**
 * Bounds for --gate (medians). Generous on purpose: they catch a return to
 * rendering the whole transcript (seconds to first render, tens of thousands
 * of DOM nodes, multi-second long tasks), not small regressions.
 */
const GATE = {
  readyMs: 2_500,
  loadedDomNodes: 25_000,
  scrollLongestTaskMs: 400,
  topDomNodes: 30_000,
  topHeapMb: 120,
};

const credentials = JSON.parse(
  readFileSync(join(dirname(metadataPath), 'credentials.json'), 'utf8'),
);
const response = await fetch(`${metadata.urls.api}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(credentials),
});
assert(response.ok, `Fixture authentication failed (${response.status})`);
const cookies = response.headers.getSetCookie().map((header) => {
  const [pair] = header.split(';');
  const split = pair.indexOf('=');
  return {
    name: pair.slice(0, split).trim(),
    value: pair.slice(split + 1).trim(),
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
});
assert(
  cookies.some((cookie) => cookie.name.includes('session_token')),
  'No authenticated fixture cookie',
);
// The fixture account has not seen the introduction; skip it as the person would.
const skipped = await fetch(`${metadata.urls.api}/api/me/onboarding/skip`, {
  method: 'POST',
  headers: {
    origin,
    'content-type': 'application/json',
    cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
  },
  body: '{}',
});
assert(skipped.ok, `Could not skip the introduction (${skipped.status})`);

const probe = fileURLToPath(new URL('./browser-performance-probe.js', import.meta.url));
// Records when each end of the conversation is first in the page, and frame
// intervals while `recording` is on. Counts and timings only.
const longProbe = `(() => {
  const state = { firstArticleAt: null, endAt: null, paintedAt: null, recording: false, frames: [] };
  window.__ociLong = state;
  const check = () => {
    if (state.firstArticleAt === null && document.querySelector('article')) state.firstArticleAt = performance.now();
    if (state.endAt === null && document.body && document.body.textContent.includes('LONG-FIXTURE-END')) {
      state.endAt = performance.now();
      // The frame that shows it: after the next animation frame has been produced.
      requestAnimationFrame(() => setTimeout(() => { state.paintedAt = performance.now(); }, 0));
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  let last = null;
  const frame = (now) => {
    if (state.recording && last !== null && state.frames.length < 20000) state.frames.push(now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();`;

const output = mkdtempSync(join(tmpdir(), 'oci-long-conversation-'));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
const quantile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? null;
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);

const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
const rows = [];
try {
  for (let trial = 0; trial < trials; trial++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.addCookies(cookies);
      await context.addInitScript({ path: probe });
      await context.addInitScript(longProbe);
      const page = await context.newPage();
      let pageErrors = 0;
      page.on('pageerror', () => pageErrors++);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      const metrics = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        const { metrics: list } = await cdp.send('Performance.getMetrics');
        const value = (name) => list.find((metric) => metric.name === name)?.value ?? null;
        return {
          heapMb: round(value('JSHeapUsedSize') / 1024 / 1024),
          domNodes: await page.evaluate(() => document.getElementsByTagName('*').length),
          articles: await page.evaluate(() => document.querySelectorAll('article').length),
        };
      };
      const tasksBetween = (tasks, from, to) =>
        tasks.filter((task) => task.start >= from && task.start <= to);
      const summarizeTasks = (tasks) => ({
        count: tasks.length,
        totalMs: round(tasks.reduce((sum, task) => sum + task.duration, 0)),
        longestMs: round(Math.max(0, ...tasks.map((task) => task.duration))),
      });

      await page.goto(origin + scenario.path);
      await page.waitForFunction(
        () =>
          window.__ociLong?.paintedAt != null && window.__ociPerformance?.composerReadyAt != null,
        undefined,
        { timeout: 300_000, polling: 100 },
      );
      await page.waitForTimeout(1_500);
      const loadState = await page.evaluate(() => ({
        endAt: window.__ociLong.endAt,
        paintedAt: window.__ociLong.paintedAt,
        firstArticleAt: window.__ociLong.firstArticleAt,
        composerReadyAt: window.__ociPerformance.composerReadyAt,
        longTasks: window.__ociPerformance.longTasks,
        historyBytes: performance
          .getEntriesByType('resource')
          .filter((entry) => new URL(entry.name).pathname.endsWith('/messages'))
          .reduce((sum, entry) => sum + entry.encodedBodySize, 0),
      }));
      const loaded = await metrics();
      const loadTasks = summarizeTasks(
        tasksBetween(loadState.longTasks, 0, loadState.paintedAt + 1_000),
      );

      // Scroll up 40 wheel notches of 1,000 px, 50 ms apart, as a reader would.
      await page.mouse.move(760, 400);
      const scrollStart = await page.evaluate(() => {
        window.__ociLong.frames = [];
        window.__ociLong.recording = true;
        return performance.now();
      });
      for (let step = 0; step < 40; step++) {
        await page.mouse.wheel(0, -1_000);
        await page.waitForTimeout(50);
      }
      await page.waitForTimeout(500);
      const scrollState = await page.evaluate(() => {
        window.__ociLong.recording = false;
        return {
          end: performance.now(),
          frames: window.__ociLong.frames,
          longTasks: window.__ociPerformance.longTasks,
        };
      });
      const scrollTasks = summarizeTasks(
        tasksBetween(scrollState.longTasks, scrollStart, scrollState.end),
      );
      const frames = scrollState.frames;

      // Then all the way to the first message.
      const topStart = await page.evaluate(() => performance.now());
      const startVisible = () =>
        page.evaluate(() => {
          const scroller = document.querySelector('[data-conversation-scroller]');
          if (!scroller) return false;
          const view = scroller.getBoundingClientRect();
          return [...document.querySelectorAll('article')].some((article) => {
            if (!article.textContent.includes('LONG-FIXTURE-START')) return false;
            const box = article.getBoundingClientRect();
            return box.bottom > view.top && box.top < view.bottom;
          });
        });
      const deadline = Date.now() + 600_000;
      while (!(await startVisible())) {
        assert(Date.now() < deadline, 'Did not reach the first message');
        await page.mouse.wheel(0, -4_000);
        await page.waitForTimeout(40);
      }
      const topState = await page.evaluate(() => ({
        end: performance.now(),
        longTasks: window.__ociPerformance.longTasks,
      }));
      const topTasks = summarizeTasks(tasksBetween(topState.longTasks, topStart, topState.end));
      await page.waitForTimeout(500);
      const top = await metrics();

      const row = {
        label,
        trial,
        cpuThrottle: throttle,
        historyBytes: loadState.historyBytes,
        firstArticleMs: round(loadState.firstArticleAt),
        inDomMs: round(loadState.endAt),
        readyMs: round(loadState.paintedAt),
        composerReadyMs: round(loadState.composerReadyAt),
        loadedHeapMb: loaded.heapMb,
        loadedDomNodes: loaded.domNodes,
        loadedArticles: loaded.articles,
        loadLongTasks: loadTasks,
        scrollFrames: frames.length,
        scrollFrameP95Ms: round(quantile(frames, 0.95)),
        scrollFramesOver50Ms: frames.filter((value) => value > 50).length,
        scrollLongestFrameMs: round(Math.max(0, ...frames)),
        scrollLongTasks: scrollTasks,
        toTopMs: round(topState.end - topStart),
        toTopLongTasks: topTasks,
        topHeapMb: top.heapMb,
        topDomNodes: top.domNodes,
        topArticles: top.articles,
        pageErrors,
      };
      assert.equal(pageErrors, 0, 'Page errors during the measurement');
      rows.push(row);
      writeFileSync(join(output, 'summary.json'), JSON.stringify({ label, rows }, null, 2), {
        mode: 0o600,
      });
      console.log(JSON.stringify(row));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const medians = {
  readyMs: median(rows.map((row) => row.readyMs)),
  inDomMs: median(rows.map((row) => row.inDomMs)),
  firstArticleMs: median(rows.map((row) => row.firstArticleMs)),
  loadedHeapMb: median(rows.map((row) => row.loadedHeapMb)),
  loadedDomNodes: median(rows.map((row) => row.loadedDomNodes)),
  loadLongTaskTotalMs: median(rows.map((row) => row.loadLongTasks.totalMs)),
  loadLongestTaskMs: median(rows.map((row) => row.loadLongTasks.longestMs)),
  scrollFrameP95Ms: median(rows.map((row) => row.scrollFrameP95Ms)),
  scrollFramesOver50Ms: median(rows.map((row) => row.scrollFramesOver50Ms)),
  scrollLongestTaskMs: median(rows.map((row) => row.scrollLongTasks.longestMs)),
  scrollLongTaskTotalMs: median(rows.map((row) => row.scrollLongTasks.totalMs)),
  toTopMs: median(rows.map((row) => row.toTopMs)),
  toTopLongTaskTotalMs: median(rows.map((row) => row.toTopLongTasks.totalMs)),
  topHeapMb: median(rows.map((row) => row.topHeapMb)),
  topDomNodes: median(rows.map((row) => row.topDomNodes)),
};
writeFileSync(join(output, 'summary.json'), JSON.stringify({ label, rows, medians }, null, 2), {
  mode: 0o600,
});
console.log(`Medians (${label}): ${JSON.stringify(medians)}`);
console.log(`Long-conversation measurement artifacts: ${output}`);
if (gate) {
  const failures = Object.entries(GATE).filter(([key, bound]) => !(medians[key] <= bound));
  for (const [key, bound] of failures)
    console.error(`Gate failed: median ${key} ${medians[key]} > ${bound}`);
  if (failures.length) process.exit(1);
  console.log('Long-conversation gate passed.');
}

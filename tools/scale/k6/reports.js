/**
 * Report pages in isolation: one administrator requests each usage report
 * page back to back, with no other load, so the numbers are the cost of the
 * report queries themselves (docs/dev/scale-harness.md, "Usage rollups").
 * Run against a stack left by `run.sh --keep`:
 *
 *   docker compose -p oci-scale -f tools/scale/compose.yaml --profile tools \
 *     run --rm -e SCALE_SUMMARY=/results/k6-reports.json k6 run --quiet /scale/k6/reports.js
 */
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { BASE, ensureSignedIn, fixtures, params, trendStats } from './lib.js';

const PAGES = [
  ['usage-overview', '/api/admin/usage/overview?days=30'],
  ['usage-spend', '/api/admin/usage/spend?days=30'],
  ['usage-spend-90', '/api/admin/usage/spend?days=90'],
  ['usage-spend-7', '/api/admin/usage/spend?days=7'],
  ['overview', '/api/admin/overview'],
];
const ITERATIONS = Number(__ENV.SCALE_REPORT_ITERATIONS || 30);
const reportMs = new Trend('report_ms', true);

export const options = {
  scenarios: {
    reports: { executor: 'per-vu-iterations', vus: 1, iterations: ITERATIONS, maxDuration: '30m' },
  },
  thresholds: Object.fromEntries(PAGES.map(([page]) => [`report_ms{page:${page}}`, ['p(95)>=0']])),
  summaryTrendStats: trendStats(),
  // One signed-in administrator throughout.
  noCookiesReset: true,
};

export default function () {
  if (!ensureSignedIn(fixtures.admin.email)) return;
  for (const [page, path] of PAGES) {
    const res = http.get(`${BASE}${path}`, params(`report-${page}`, { timeout: '120s' }));
    if (res.status === 200) reportMs.add(res.timings.duration, { page });
    else console.warn(`${page}: ${res.status}`);
  }
}

export function handleSummary(data) {
  const lines = PAGES.map(([page]) => {
    const values = data.metrics[`report_ms{page:${page}}`]?.values ?? {};
    const fmt = (key) => (values[key] === undefined ? '-' : values[key].toFixed(1));
    return `${page.padEnd(16)} median ${fmt('med')} ms  p95 ${fmt('p(95)')} ms  max ${fmt('max')} ms  n ${values.count ?? 0}`;
  });
  return {
    stdout: `${lines.join('\n')}\n`,
    [__ENV.SCALE_SUMMARY || '/results/k6-reports.json']: JSON.stringify(data, null, 2),
  };
}

/**
 * Main scale-test run: a sign-in storm, then a mixed steady state in which
 * people browse (sidebar + conversation), chat with the stub model, search,
 * chat in projects (keyword and meaning-based retrieval), administrators read
 * reports, and an administrator keeps the indexing and embedding jobs busy.
 *
 *   SCALE_PROFILE=small SCALE_PHASE=main k6 run main.js
 *
 * Thresholds are the proposed targets (design doc, "Open questions"). k6
 * exits 99 when one fails; run.sh reports that and fails only with --enforce.
 */
import exec from 'k6/execution';
import http from 'k6/http';
import { PROFILES, TARGETS } from '../profiles.mjs';
import {
  ADMIN_PAGES,
  BASE,
  browseOnce,
  digest,
  ensureSignedIn,
  fixtures,
  forThisVu,
  metrics,
  PROMPTS,
  params,
  randomItem,
  runJob,
  sendMessage,
  signinOnce,
  think,
  trendStats,
} from './lib.js';

const PROFILE = PROFILES[__ENV.SCALE_PROFILE || 'tiny'];
if (!PROFILE) throw new Error(`Unknown SCALE_PROFILE ${__ENV.SCALE_PROFILE}`);
const PHASE = __ENV.SCALE_PHASE || 'main';
const load = PROFILE.load;

function buildScenarios() {
  if (PHASE === 'warm') {
    // Fills caches and connection pools; its numbers are not reported.
    const steady = { executor: 'constant-vus', duration: '20s', gracefulStop: '10s' };
    return {
      browse: { ...steady, exec: 'browse', vus: 2 },
      search: { ...steady, exec: 'search', vus: 1 },
      chat: { ...steady, exec: 'chat', vus: 1 },
    };
  }
  const stormSeconds = load.signinRampSeconds + load.signinHoldSeconds + 5;
  const startTime = `${stormSeconds + 5}s`;
  const steady = (exec, vus) => ({
    executor: 'constant-vus',
    exec,
    vus,
    duration: `${load.steadySeconds}s`,
    startTime,
    gracefulStop: '60s',
  });
  const all = {
    signin: {
      executor: 'ramping-arrival-rate',
      exec: 'signin',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: Math.ceil(load.signinRate * 2),
      maxVUs: load.signinRate * 8,
      stages: [
        { duration: `${load.signinRampSeconds}s`, target: load.signinRate },
        { duration: `${load.signinHoldSeconds}s`, target: load.signinRate },
        { duration: '5s', target: 0 },
      ],
    },
    browse: steady('browse', load.vus.browse),
    chat: steady('chat', load.vus.chat),
    search: steady('search', load.vus.search),
    project: steady('project', load.vus.project),
    admin: steady('admin', load.vus.admin),
    jobs: steady('jobs', load.vus.jobs),
  };
  if (fixtures.projectThreads.length === 0) delete all.project;
  const only = (__ENV.SCALE_SCENARIOS || '').split(',').filter(Boolean);
  if (only.length === 0) return all;
  return Object.fromEntries(Object.entries(all).filter(([name]) => only.includes(name)));
}

const scenarios = buildScenarios();

function thresholds() {
  if (PHASE === 'warm') return {};
  const out = {};
  for (const [metric, target] of Object.entries(TARGETS)) out[metric] = [`p(95)<${target}`];
  for (const name of Object.keys(scenarios)) out[`errors{scenario:${name}}`] = ['rate<0.01'];
  // Sub-metrics only appear in the summary when a threshold names them.
  for (const bucket of ['common', 'medium', 'rare', 'phrase']) {
    out[`search_ms{bucket:${bucket}}`] = ['p(95)>=0'];
  }
  for (const [page] of ADMIN_PAGES) out[`admin_ms{page:${page}}`] = ['p(95)>=0'];
  for (const prompt of ['short', 'medium', 'long']) {
    out[`chat_pre_model_ms{prompt:${prompt}}`] = ['p(95)>=0'];
  }
  for (const files of ['searched', 'whole'])
    out[`project_pre_model_ms{files:${files}}`] = ['p(95)>=0'];
  for (const job of ['index', 'embed']) {
    out[`job_ms{job:${job}}`] = ['p(95)>=0'];
    out[`job_items{job:${job}}`] = ['count>=0'];
  }
  return out;
}

export const options = {
  scenarios,
  thresholds: thresholds(),
  summaryTrendStats: trendStats(),
  discardResponseBodies: false,
  // Each VU is one person who stays signed in; k6 otherwise drops cookies
  // between iterations.
  noCookiesReset: true,
  // Arrival-rate sign-ins that cannot start in time are reported, not hidden.
  setupTimeout: '120s',
};

export function signin() {
  signinOnce();
}

export function browse() {
  browseOnce(forThisVu(fixtures.browse));
  think(1, 3);
}

let chatThreads = null;
let chatIterations = 0;

export function chat() {
  const person = forThisVu(fixtures.chat);
  if (!ensureSignedIn(person.email)) return;
  if (!chatThreads || chatIterations++ % 20 === 0) {
    const res = http.get(`${BASE}/api/threads?view=sidebar`, params('threads-sidebar'));
    chatThreads = res.status === 200 ? (res.json('threads') || []).map((t) => t.id) : [];
  }
  if (chatThreads.length === 0) return;
  const threadId = chatThreads[Math.floor(Math.random() ** 2 * Math.min(chatThreads.length, 30))];
  sendMessage(threadId, randomItem(PROMPTS), {
    errors: metrics.errors,
    ttfb: metrics.chatTtfb,
    total: metrics.chatTotal,
    preModel: metrics.chatPreModel,
    tail: metrics.chatTail,
  });
  think(3, 8);
}

const largeProjects = fixtures.projectThreads.filter((entry) => entry.large);
const smallProjects = fixtures.projectThreads.filter((entry) => !entry.large);

/**
 * Half the project VUs work in large projects (passages searched), half in
 * ordinary ones (files included whole); each VU keeps one person and thread.
 */
function projectEntry() {
  const id = exec.vu.idInTest;
  const pool =
    (id % 2 === 0 && largeProjects.length > 0) || smallProjects.length === 0
      ? largeProjects
      : smallProjects;
  return pool[Math.floor((id - 1) / 2) % pool.length];
}

export function project() {
  const entry = projectEntry();
  if (!ensureSignedIn(entry.email)) return;
  const [a, b] = entry.terms;
  sendMessage(entry.threadId, `What do my files say about ${a} and ${b}?`, {
    errors: metrics.errors,
    ttfb: metrics.projectTtfb,
    total: metrics.projectTotal,
    preModel: metrics.projectPreModel,
    tags: { files: entry.large ? 'searched' : 'whole' },
  });
  think(3, 8);
}

const BUCKETS = [
  ['common', 0.3],
  ['medium', 0.4],
  ['rare', 0.2],
  ['phrase', 0.1],
];

export function search() {
  // From the other end of the list than the browsing VUs.
  const list = fixtures.browse;
  const person = list[list.length - 1 - ((exec.vu.idInTest - 1) % list.length)];
  if (!ensureSignedIn(person.email)) return;
  let roll = Math.random();
  let bucket = 'medium';
  for (const [name, share] of BUCKETS) {
    roll -= share;
    if (roll < 0) {
      bucket = name;
      break;
    }
  }
  const term = randomItem(fixtures.searchTerms[bucket]);
  const res = http.get(
    `${BASE}/api/threads/search?q=${encodeURIComponent(term)}&limit=20`,
    params('search', { tags: { name: 'search', bucket } }),
  );
  const ok = res.status === 200;
  metrics.errors.add(!ok);
  if (ok) metrics.search.add(res.timings.duration, { bucket });
  think(2, 5);
}

export function admin() {
  if (!ensureSignedIn(fixtures.admin.email)) return;
  for (const [page, path] of ADMIN_PAGES) {
    const res = http.get(`${BASE}${path}`, params(`admin-${page}`, { timeout: '120s' }));
    const ok = res.status === 200;
    metrics.errors.add(!ok);
    if (ok) metrics.admin.add(res.timings.duration, { page });
    think(1, 3);
  }
}

export function jobs() {
  if (!ensureSignedIn(fixtures.admin.email)) return;
  runJob('projects.index-files', 'index');
  runJob('projects.embed-passages', 'embed');
  think(3, 6);
}

export function handleSummary(data) {
  const path = __ENV.SCALE_SUMMARY || `/results/k6-${PHASE}.json`;
  return {
    [path]: JSON.stringify(data, null, 2),
    stdout: digest(data, [
      'signin_ms',
      'sidebar_ms',
      'conversation_open_ms',
      'chat_pre_model_ms',
      'chat_ttfb_ms',
      'chat_total_ms',
      'project_pre_model_ms',
      'search_ms',
      'admin_ms',
      'job_ms',
      'signin_retries',
      'errors',
    ]),
  };
}

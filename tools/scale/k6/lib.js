/**
 * Shared pieces of the scale-test scenarios (run by k6 from its official
 * container image; see tools/scale/compose.yaml).
 *
 * Every request goes through the web container's Caddy proxy, as a browser's
 * would, with the session cookie Better Auth issues at sign-in.
 */
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

export const BASE = __ENV.SCALE_BASE_URL || 'http://web:8080';
export const ORIGIN = __ENV.SCALE_ORIGIN || 'http://127.0.0.1:18080';
export const STUB = __ENV.SCALE_STUB_URL || 'http://stub:4181';

export const fixtures = new SharedArray('fixtures', () => [
  JSON.parse(open(__ENV.SCALE_FIXTURES || '/results/fixtures.json')),
])[0];

export const metrics = {
  errors: new Rate('errors'),
  signin: new Trend('signin_ms', true),
  signinRetries: new Counter('signin_retries'),
  sidebar: new Trend('sidebar_ms', true),
  sidebarThreads: new Trend('sidebar_threads_ms', true),
  conversationOpen: new Trend('conversation_open_ms', true),
  conversationMessages: new Trend('conversation_messages'),
  chatTtfb: new Trend('chat_ttfb_ms', true),
  chatTotal: new Trend('chat_total_ms', true),
  chatPreModel: new Trend('chat_pre_model_ms', true),
  chatTail: new Trend('chat_tail_ms', true),
  projectTtfb: new Trend('project_ttfb_ms', true),
  projectTotal: new Trend('project_total_ms', true),
  projectPreModel: new Trend('project_pre_model_ms', true),
  search: new Trend('search_ms', true),
  admin: new Trend('admin_ms', true),
  job: new Trend('job_ms', true),
  jobItems: new Counter('job_items'),
};

/**
 * Each simulated person gets their own client address (from 198.18.0.0/15,
 * the benchmarking range), sent as X-Forwarded-For; the harness's web proxy
 * trusts the compose network, so the API sees one address per person as it
 * would in production, instead of every virtual user sharing k6's address.
 *
 * With `SCALE_SIGNIN_ADDRESSES=N` everyone shares N addresses instead, as a
 * campus behind a few NAT addresses does (the storm phase, storm.js).
 */
const SHARED_ADDRESSES = Number(__ENV.SCALE_SIGNIN_ADDRESSES || 0);

export function addressFor(email) {
  let h = 0x811c9dc5;
  for (let i = 0; i < email.length; i++) {
    h ^= email.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  if (SHARED_ADDRESSES > 0) return `198.18.0.${(h % SHARED_ADDRESSES) + 1}`;
  return `198.${18 + (h >>> 31)}.${(h >>> 8) & 255}.${h & 255}`;
}

let currentAddress = '198.18.0.1';

export function params(name, extra = {}, address = currentAddress) {
  return {
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-forwarded-for': address,
    },
    tags: { name },
    ...extra,
  };
}

export function think(min, max) {
  sleep(min + Math.random() * (max - min));
}

/** A distinct entry per VU while the list is long enough. */
export function forThisVu(list) {
  return list[(exec.vu.idInTest - 1) % list.length];
}

export function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

let signedInAs = null;
let failuresLogged = 0;

/** Logs the first few failures of each VU. */
export function noteFailure(name, res) {
  if (failuresLogged++ >= 3) return;
  // Error bodies are short JSON with a code and message; the data is synthetic.
  const body = typeof res.body === 'string' && res.status >= 400 ? res.body.slice(0, 200) : '';
  console.warn(`${name} failed: HTTP ${res.status} ${res.error || ''} ${body}`);
}

/** Signs the VU in once (its cookie jar keeps the session); false when that failed. */
export function ensureSignedIn(email) {
  if (signedInAs === email) return true;
  http.cookieJar().clear(BASE);
  currentAddress = addressFor(email);
  let res;
  // Better Auth allows three sign-ins per address in ten seconds; the storm
  // may just have used them. A browser would wait and retry, so this does too.
  for (let attempt = 0; attempt < 6; attempt++) {
    res = http.post(
      `${BASE}/api/auth/sign-in/email`,
      JSON.stringify({ email, password: fixtures.password }),
      params('vu-sign-in'),
    );
    if (res.status !== 429) break;
    metrics.signinRetries.add(1);
    sleep(Number(res.headers['Retry-After']) || 3 + Math.random() * 3);
  }
  const ok = check(res, { 'sign-in 200': (r) => r.status === 200 });
  metrics.errors.add(!ok);
  if (!ok) {
    noteFailure('sign-in', res);
    signedInAs = null;
    sleep(1);
    return false;
  }
  signedInAs = email;
  return true;
}

/** Sign-in storm: a fresh session per attempt, nothing else. */
export function signinOnce() {
  // Everyone in turn, as on a term's first morning: each person signs in once
  // per pass through the list rather than several times in a row.
  const people = fixtures.browse.length + fixtures.chat.length;
  const n = exec.scenario.iterationInTest % people;
  const person =
    n < fixtures.browse.length ? fixtures.browse[n] : fixtures.chat[n - fixtures.browse.length];
  const jar = new http.CookieJar();
  const res = http.post(
    `${BASE}/api/auth/sign-in/email`,
    JSON.stringify({ email: person.email, password: fixtures.password }),
    params('sign-in', { jar }, addressFor(person.email)),
  );
  const ok = check(res, { 'storm sign-in 200': (r) => r.status === 200 });
  metrics.errors.add(!ok);
  if (!ok) noteFailure('storm sign-in', res);
  metrics.signin.add(res.timings.duration);
}

/**
 * What the web app does when it opens: the sidebar's requests in parallel,
 * then one conversation. `sidebar_ms` is the wall time of the parallel batch
 * (what the person waits for); `conversation_open_ms` the conversation fetch.
 */
export function browseOnce(person, trends = metrics) {
  if (!ensureSignedIn(person.email)) return;
  const started = Date.now();
  const requests = [
    ['GET', `${BASE}/api/me`, null, params('me')],
    ['GET', `${BASE}/api/threads?view=sidebar`, null, params('threads-sidebar')],
    ['GET', `${BASE}/api/models`, null, params('models')],
  ];
  // Roles without projects have no project tree, so the web app skips it.
  if (person.projects !== false) {
    requests.push(['GET', `${BASE}/api/projects/sidebar`, null, params('projects-sidebar')]);
  }
  const responses = http.batch(requests);
  const sidebarOk = responses.every((r) => r.status === 200);
  check(responses, { 'sidebar 200': () => sidebarOk });
  trends.errors.add(!sidebarOk);
  if (!sidebarOk) {
    for (const r of responses) if (r.status !== 200) noteFailure(r.request.url, r);
    return;
  }
  trends.sidebar.add(Date.now() - started);
  trends.sidebarThreads.add(responses[1].timings.duration);
  const threads = responses[1].json('threads') || [];
  if (threads.length === 0) return;
  think(0.3, 1.2);
  // People mostly reopen something recent.
  const thread = threads[Math.floor(Math.random() ** 2 * Math.min(threads.length, 50))];
  const res = http.get(`${BASE}/api/chat/${thread.id}/messages`, params('conversation'));
  const ok = check(res, { 'conversation 200': (r) => r.status === 200 });
  trends.errors.add(!ok);
  if (!ok) return;
  trends.conversationOpen.add(res.timings.duration);
  trends.conversationMessages.add((res.json('messages') || []).length);
}

let marker = 0;

/**
 * Sends a message and reads the stream to its end. The stub records when the
 * model request carrying the marker arrived, so `pre_model` is exactly the
 * time OCI spent before the model was asked (authentication, limits, quota,
 * saving the turn, building context, project retrieval); the stub's own
 * first-token delay is excluded by construction.
 */
export function sendMessage(threadId, text, set) {
  marker++;
  const id = `${exec.vu.idInTest}-${marker}-${Date.now()}`;
  const body = {
    threadId,
    messages: [{ role: 'user', parts: [{ type: 'text', text: `${text} [scale:${id}]` }] }],
    modelSlug: fixtures.model,
  };
  const sentAt = Date.now();
  const res = http.post(
    `${BASE}/api/chat`,
    JSON.stringify(body),
    params('chat', { timeout: '180s' }),
  );
  const endedAt = Date.now();
  const ok = check(res, {
    'chat 200': (r) => r.status === 200,
    'chat stream finished': (r) => typeof r.body === 'string' && r.body.includes('"finish"'),
  });
  set.errors.add(!ok);
  if (!ok) {
    noteFailure('chat', res);
    return false;
  }
  set.ttfb.add(res.timings.waiting);
  set.total.add(res.timings.duration);
  const mark = http.get(`${STUB}/marks/${id}`, { tags: { name: 'stub-mark' } });
  if (mark.status === 200) {
    const timing = mark.json();
    // What OCI sent the model, in characters: long histories cost more to load and assemble.
    const prompt =
      timing.promptChars < 20_000 ? 'short' : timing.promptChars < 150_000 ? 'medium' : 'long';
    set.preModel.add(Math.max(0, timing.receivedAt - sentAt), { prompt, ...(set.tags ?? {}) });
    if (set.tail && timing.lastTokenAt) set.tail.add(Math.max(0, endedAt - timing.lastTokenAt));
  }
  return true;
}

export const PROMPTS = [
  'Can you tighten this paragraph and keep the meaning?',
  'Summarise what we decided so far.',
  'Give me two more examples like the last one.',
  'What should I check before sending this?',
  'Turn that into a short checklist.',
];

export function runJob(name, label) {
  const started = Date.now();
  const res = http.post(
    `${BASE}/api/admin/lifecycle/jobs/${name}/run`,
    '{}',
    params(`job-${label}`, { timeout: '1800s' }),
  );
  const ok = check(res, { [`job ${label} 200`]: (r) => r.status === 200 });
  metrics.errors.add(!ok);
  if (!ok) return null;
  const result = res.json();
  if (!result.skipped) {
    metrics.job.add(Date.now() - started, { job: label });
    metrics.jobItems.add(result.itemsProcessed || 0, { job: label });
  }
  return result;
}

export const ADMIN_PAGES = [
  ['overview', '/api/admin/overview'],
  ['usage-overview', '/api/admin/usage/overview?days=30'],
  ['usage-spend', '/api/admin/usage/spend?days=30'],
  ['usage-limits', '/api/admin/usage/limits?days=30'],
  ['usage-storage', '/api/admin/usage/storage'],
  ['users', '/api/admin/users'],
  ['audit', '/api/admin/audit?limit=50'],
  ['health', '/api/admin/health'],
];

export function trendStats() {
  return ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'];
}

/** A short plain-text digest for the console; the JSON summary has everything. */
export function digest(data, names) {
  const lines = [];
  for (const name of names) {
    const metric = data.metrics[name];
    if (!metric) continue;
    const v = metric.values;
    if (v['p(95)'] !== undefined) {
      lines.push(
        `${name.padEnd(28)} p50 ${v.med.toFixed(0).padStart(7)}  p95 ${v['p(95)'].toFixed(0).padStart(7)}  p99 ${v['p(99)'].toFixed(0).padStart(7)}  n ${v.count}`,
      );
    } else if (v.passes !== undefined) {
      lines.push(`${name.padEnd(28)} rate ${(v.rate * 100).toFixed(2)}%`);
    } else if (v.count !== undefined) {
      lines.push(`${name.padEnd(28)} count ${v.count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

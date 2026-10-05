/**
 * Sign-in storm phase (v0.11 design, item 22): a term's first morning, with
 * every virtual user behind a few client addresses (a campus NAT), first with
 * passwords and then through single sign-on against the stub OpenID Connect
 * provider (stub/oidc.mjs, registered by run.sh as `scale-idp`).
 *
 *   SCALE_PROFILE=small SCALE_SIGNIN_ADDRESSES=4 k6 run storm.js
 *
 * - `password`: `POST /api/auth/sign-in/email` with a fresh cookie jar, the
 *   generated people in turn, at the profile's sign-in rate.
 * - `sso`: `POST /api/auth/sign-in/sso` (login hint), the identity provider's
 *   `authorize` (which redirects straight back), then OCI's callback, which
 *   exchanges the code, creates or links the account, provisions it and sets
 *   the session. The first half of the run signs in people OCI has never
 *   seen (just-in-time provisioning); the second half signs the same people
 *   in again.
 */
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { PROFILES } from '../profiles.mjs';
import {
  addressFor,
  BASE,
  digest,
  fixtures,
  noteFailure,
  ORIGIN,
  params,
  trendStats,
} from './lib.js';

const PROFILE = PROFILES[__ENV.SCALE_PROFILE || 'tiny'];
if (!PROFILE) throw new Error(`Unknown SCALE_PROFILE ${__ENV.SCALE_PROFILE}`);
// SCALE_STORM_RATE overrides the profile's sign-ins per second, to find where a replica saturates.
const load = {
  ...PROFILE.load,
  signinRate: Number(__ENV.SCALE_STORM_RATE || PROFILE.load.signinRate),
};
const PROVIDER = __ENV.SCALE_SSO_PROVIDER || 'scale-idp';
const SSO = __ENV.SCALE_SSO !== 'false';

const stormSeconds = load.signinRampSeconds + load.signinHoldSeconds + 5;
// People the SSO storm signs in: everyone once, then everyone again.
const ssoPeople = Math.max(1, Math.floor((load.signinRate * stormSeconds) / 2));

const metrics = {
  errors: new Rate('errors'),
  signin: new Trend('signin_ms', true),
  signin429: new Counter('signin_429'),
  sso: new Trend('sso_signin_ms', true),
  ssoCallback: new Trend('sso_callback_ms', true),
  sso429: new Counter('sso_429'),
};

function storm(execName, startTime) {
  return {
    executor: 'ramping-arrival-rate',
    exec: execName,
    startRate: 1,
    timeUnit: '1s',
    startTime,
    preAllocatedVUs: Math.ceil(load.signinRate * 2),
    maxVUs: load.signinRate * 8,
    stages: [
      { duration: `${load.signinRampSeconds}s`, target: load.signinRate },
      { duration: `${load.signinHoldSeconds}s`, target: load.signinRate },
      { duration: '5s', target: 0 },
    ],
  };
}

const scenarios = { password: storm('password', '0s') };
if (SSO) scenarios.sso = storm('sso', `${stormSeconds + 5}s`);

export const options = {
  scenarios,
  thresholds: {
    'errors{scenario:password}': ['rate<0.01'],
    ...(SSO ? { 'errors{scenario:sso}': ['rate<0.01'] } : {}),
    'sso_callback_ms{kind:new}': ['p(95)>=0'],
    'sso_callback_ms{kind:returning}': ['p(95)>=0'],
  },
  summaryTrendStats: trendStats(),
  discardResponseBodies: false,
  noCookiesReset: true,
};

export function password() {
  const people = fixtures.browse.length + fixtures.chat.length;
  const n = exec.scenario.iterationInTest % people;
  const person =
    n < fixtures.browse.length ? fixtures.browse[n] : fixtures.chat[n - fixtures.browse.length];
  const jar = new http.CookieJar();
  const res = http.post(
    `${BASE}/api/auth/sign-in/email`,
    JSON.stringify({ email: person.email, password: fixtures.password }),
    params('storm-sign-in', { jar }, addressFor(person.email)),
  );
  const ok = res.status === 200;
  if (res.status === 429) metrics.signin429.add(1);
  metrics.errors.add(!ok);
  if (!ok) noteFailure('storm sign-in', res);
  metrics.signin.add(res.timings.duration);
}

/** OCI's callback as k6 reaches it: the identity provider redirects to APP_URL. */
function throughProxy(location) {
  return location.replace(/^https?:\/\/[^/]+/, BASE);
}

export function sso() {
  const iteration = exec.scenario.iterationInTest;
  const kind = iteration < ssoPeople ? 'new' : 'returning';
  const email = `sso-${iteration % ssoPeople}@scale.test`;
  const address = addressFor(email);
  const jar = new http.CookieJar();
  const started = Date.now();
  const fail = (step, res) => {
    if (res.status === 429) metrics.sso429.add(1);
    metrics.errors.add(true);
    noteFailure(`sso ${step}`, res);
  };

  const start = http.post(
    `${BASE}/api/auth/sign-in/sso`,
    JSON.stringify({ providerId: PROVIDER, callbackURL: `${ORIGIN}/`, loginHint: email }),
    params('sso-start', { jar }, address),
  );
  if (start.status !== 200) return fail('start', start);
  const authorize = http.get(start.json('url'), {
    jar,
    redirects: 0,
    tags: { name: 'idp-authorize' },
  });
  if (authorize.status !== 302) return fail('authorize', authorize);
  const callback = http.get(
    throughProxy(authorize.headers.Location),
    params('sso-callback', { jar, redirects: 0, tags: { name: 'sso-callback', kind } }, address),
  );
  const location = callback.headers.Location || '';
  if (callback.status !== 302 || location.includes('error=')) return fail('callback', callback);
  metrics.errors.add(false);
  metrics.ssoCallback.add(callback.timings.duration, { kind });
  metrics.sso.add(Date.now() - started, { kind });
}

export function handleSummary(data) {
  const path = __ENV.SCALE_SUMMARY || '/results/k6-storm.json';
  return {
    [path]: JSON.stringify(data, null, 2),
    stdout: digest(data, [
      'signin_ms',
      'signin_429',
      'sso_signin_ms',
      'sso_callback_ms',
      'sso_callback_ms{kind:new}',
      'sso_callback_ms{kind:returning}',
      'sso_429',
      'errors',
      'errors{scenario:password}',
      'errors{scenario:sso}',
    ]),
  };
}

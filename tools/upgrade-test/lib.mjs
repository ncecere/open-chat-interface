// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone test tool, never a Turbo task.
/**
 * Shared helpers for the rolling-upgrade test: an HTTP client that keeps
 * cookies and classifies failures the way the design's "no downtime"
 * definition does, an AI SDK UI-message stream reader, and Docker Compose
 * wrappers. No dependencies beyond Node 22.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(TOOL_DIR, '../..');
/**
 * The compose project. `OCI_UPGRADE_PROJECT` runs a second test beside one
 * already running (with `--port` set apart too); TO images are named after it.
 */
export const PROJECT = process.env.OCI_UPGRADE_PROJECT || 'oci-upgrade';
export const COMPOSE_FILE = resolve(TOOL_DIR, 'compose.yaml');

export const ADMIN = { email: 'admin@upgrade.test', password: 'upgrade-test-admin-password' };
export const PERSON_PASSWORD = 'upgrade-test-person-password';
export const MODEL_SLUG = 'upgrade-stub';
export const personEmail = (n) => `person${String(n).padStart(3, '0')}@upgrade.test`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ipCounter = 0;
/** A distinct documentation-range (TEST-NET-2) address per client. */
export function syntheticIp() {
  ipCounter++;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

/** Methods a client may repeat without changing the outcome (RFC 9110 9.2.2). */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function errorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  return error?.cause?.code ?? error?.code ?? error?.name ?? 'ERROR';
}

/**
 * A cookie-keeping client. `bases` are equivalent entry points (the web
 * replicas): a refused connection never reached a server, so moving to the
 * next one is what any load balancer does, for every method. Otherwise only
 * idempotent requests are retried, once, on a network error or 502/503/504;
 * the retry is recorded so the report can show it.
 */
export class Client {
  constructor({
    bases,
    origin,
    record = () => {},
    timeoutMs = 30_000,
    label = '',
    clientIp,
    drained = new Set(),
  }) {
    this.bases = bases;
    /** Entry points taken out of rotation, as a load balancer drains a node before it stops. */
    this.drained = drained;
    // Each simulated person has their own address (the web proxy trusts the
    // forwarded header from private ranges), as people on their own machines
    // would; otherwise every per-address limit sees one client.
    this.clientIp = clientIp ?? syntheticIp();
    this.origin = origin;
    this.record = record;
    this.timeoutMs = timeoutMs;
    this.label = label;
    this.cookies = new Map();
    this.next = Math.floor(Math.random() * bases.length);
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  keepCookies(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async attempt(method, path, body, timeoutMs) {
    let failovers = 0;
    const n = this.bases.length;
    const rotation = Array.from({ length: n }, (_, i) => this.bases[(this.next + i) % n]);
    const live = rotation.filter((b) => !this.drained.has(b));
    const candidates = live.length ? live : rotation;
    this.next = (this.next + 1) % n;
    for (let i = 0; i < candidates.length; i++) {
      const base = candidates[i];
      const headers = { accept: 'application/json, text/event-stream', origin: this.origin };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
      headers['x-forwarded-for'] = this.clientIp;
      const started = performance.now();
      try {
        const response = await fetch(base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        });
        return { response, started, ttfb: performance.now() - started, failovers };
      } catch (error) {
        if (errorCode(error) === 'ECONNREFUSED' && i < candidates.length - 1) {
          failovers++;
          continue;
        }
        return { error, started, ttfb: performance.now() - started, failovers };
      }
    }
    throw new Error('unreachable');
  }

  /**
   * One logical request. Returns `{ ok, status, json, text, outcome }` where
   * outcome is `ok`, `retried` (succeeded on the single allowed retry), or
   * `fail`. Streams are returned unread when `stream` is set.
   *
   * With `retryDrain`, a `503` carrying `Retry-After` (an API replica that is
   * shutting down refuses a new chat turn that way, before storing anything)
   * is sent again after the advertised delay, up to twice, as the web app
   * does (apps/web/src/lib/chat-retry.ts).
   */
  async request(
    name,
    method,
    path,
    { body, expect = [200], stream = false, timeoutMs, retryDrain = false } = {},
  ) {
    const at = Date.now();
    const limit = timeoutMs ?? this.timeoutMs;
    let first = await this.attempt(method, path, body, limit);
    let retried = null;
    const retryable = (a) =>
      IDEMPOTENT.has(method) && (a.error || RETRYABLE_STATUS.has(a.response.status));
    if (retryable(first)) {
      retried = first.error ? errorCode(first.error) : `HTTP ${first.response.status}`;
      if (first.response) await first.response.body?.cancel().catch(() => {});
      await sleep(250);
      first = await this.attempt(method, path, body, limit);
    }
    const drainDelay = (a) => {
      const header = a.response?.status === 503 ? a.response.headers.get('retry-after') : null;
      return header === null || !Number.isFinite(Number(header))
        ? null
        : Math.min(5000, Number(header) * 1000);
    };
    for (let n = 0; retryDrain && n < 2 && drainDelay(first) !== null; n++) {
      retried = `HTTP 503 draining${n ? ` x${n + 1}` : ''}`;
      const delay = drainDelay(first);
      await first.response.body?.cancel().catch(() => {});
      await sleep(delay);
      first = await this.attempt(method, path, body, limit);
    }
    const event = {
      at,
      vu: this.label,
      name,
      method,
      status: first.response?.status ?? 0,
      ttfb: Math.round(first.ttfb),
      failovers: first.failovers,
      retried,
    };
    if (first.error) {
      Object.assign(event, { outcome: 'fail', error: errorCode(first.error) });
      event.total = event.ttfb;
      this.record(event);
      return { ok: false, status: 0, error: event.error, event };
    }
    const response = first.response;
    this.keepCookies(response);
    const expected = expect.includes(response.status);
    if (stream && expected) {
      event.outcome = retried ? 'retried' : 'ok';
      return { ok: true, status: response.status, response, event, started: first.started };
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      Object.assign(event, { outcome: 'fail', error: `BODY_${errorCode(error)}` });
      event.total = Math.round(performance.now() - first.started);
      this.record(event);
      return { ok: false, status: response.status, error: event.error, event };
    }
    event.total = Math.round(performance.now() - first.started);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!expected) {
      event.outcome = 'fail';
      event.error = response.status >= 500 ? 'HTTP_5XX' : `UNEXPECTED_${response.status}`;
      event.detail = (json?.error?.message ?? json?.message ?? text).toString().slice(0, 200);
    } else {
      event.outcome = retried ? 'retried' : 'ok';
    }
    this.record(event);
    return { ok: expected, status: response.status, json, text, event };
  }
}

/**
 * Reads an AI SDK UI-message stream (SSE) to the end. Complete means a
 * `finish` event arrived with no `error` event; anything else (the connection
 * dropping, the stream ending early) is a cut reply.
 */
export async function readUiStream(response, { timeoutMs = 120_000 } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  const result = { finished: false, errorText: null, deltas: 0, done: false, readError: null };
  const reader = response.body.getReader();
  const timer = setTimeout(
    () => reader.cancel(new Error('stream timeout')).catch(() => {}),
    timeoutMs,
  );
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          result.done = true;
          continue;
        }
        try {
          const event = JSON.parse(data);
          if (event.type === 'finish') result.finished = true;
          else if (event.type === 'error') result.errorText = String(event.errorText ?? 'error');
          else if (event.type === 'text-delta') result.deltas++;
        } catch {}
      }
    }
  } catch (error) {
    result.readError = errorCode(error);
  } finally {
    clearTimeout(timer);
  }
  result.complete = result.finished && !result.errorText && !result.readError;
  return result;
}

/** Signs in with Better Auth's email endpoint; cookies stay on the client. */
export async function signIn(client, email, password, name = 'sign-in') {
  return client.request(name, 'POST', '/api/auth/sign-in/email', {
    body: { email, password, rememberMe: true },
  });
}

/* ------------------------------------------------------------------------ */
/* Processes and Docker                                                      */
/* ------------------------------------------------------------------------ */

export function run(command, args, { env, input, cwd = REPO_ROOT, quiet = true } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (!quiet) process.stderr.write(d);
    });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function must(promise, what) {
  const result = await promise;
  if (result.code !== 0) {
    throw new Error(
      `${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result;
}

/** Compose against this tool's project; `env` carries the image selection. */
export function compose(args, env, options = {}) {
  return run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
    env,
    ...options,
  });
}

export async function psql(sql, env, { tuples = true } = {}) {
  const args = [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'oci',
    '-d',
    'oci',
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
  ];
  if (tuples) args.push('-At', '-F', '\t');
  const result = await must(compose(args, env, { input: sql }), 'psql');
  return result.stdout;
}

export async function containerId(service, env) {
  const result = await compose(['ps', '-a', '-q', service], env);
  return result.stdout.trim().split('\n')[0] || null;
}

export async function inspect(id, format) {
  const result = await run('docker', ['inspect', '-f', format, id]);
  return result.code === 0 ? result.stdout.trim() : '';
}

export async function waitHealthy(service, env, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await containerId(service, env);
    if (id) {
      const state = await inspect(
        id,
        '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
      );
      if (state.endsWith('healthy') && !state.endsWith('unhealthy')) return;
      if (state.startsWith('exited') || state.startsWith('dead')) {
        const logs = await run('docker', ['logs', '--tail', '40', id]);
        throw new Error(`${service} exited before becoming healthy:\n${logs.stdout}${logs.stderr}`);
      }
    }
    await sleep(1000);
  }
  throw new Error(`${service} did not become healthy within ${timeoutMs / 1000}s`);
}

export async function waitHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000}s`);
}

/* ------------------------------------------------------------------------ */
/* Statistics                                                                */
/* ------------------------------------------------------------------------ */

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function latencyStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

export function parseArgs(argv, spec) {
  const options = {};
  for (const [key, def] of Object.entries(spec)) options[key] = def.default;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    let [key, value] = arg.slice(2).split(/=(.*)/s);
    const negated = key.startsWith('no-') && spec[key.slice(3)]?.type === 'boolean';
    if (negated) key = key.slice(3);
    const def = spec[key];
    if (!def) throw new Error(`Unknown option --${key}`);
    if (def.type === 'boolean') {
      options[key] = negated ? false : value === undefined ? true : value !== 'false';
      continue;
    }
    if (value === undefined) value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    options[key] = def.type === 'number' ? Number(value) : value;
  }
  return options;
}

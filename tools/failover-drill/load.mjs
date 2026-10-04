/**
 * Light, steady load for the failover drill, run as a child process of
 * run.mjs (IPC). Each virtual user is one person who signs in, loads the
 * sidebar, opens a conversation, sends a message to the stub model and reads
 * the reply to the end, and searches, with a short pause between steps: the
 * rolling-upgrade test's load (tools/upgrade-test/load.mjs), with a client
 * that also records whether a failed response was marked retryable
 * (`X-OCI-Retryable: database-connection`, docs/dev/failover.md).
 *
 * Nothing is retried by the client except what the web app retries: a chat
 * turn refused by a draining replica (503 with Retry-After). Reads are retried
 * by the API itself; a failed request here is a failure the person would see.
 *
 * Every request is written to `events.ndjson`; replies as `reply` events.
 * Usage: node load.mjs <config.json>
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { readUiStream, sleep } from '../upgrade-test/lib.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = createWriteStream(config.eventsFile, { flags: 'a' });
let stopping = false;
const counters = { requests: 0, failures: 0, replies: 0 };
const activeReplies = new Set();

function record(event) {
  counters.requests++;
  if (event.outcome === 'fail') counters.failures++;
  out.write(`${JSON.stringify(event)}\n`);
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const think = () => sleep(config.thinkMs * (0.5 + Math.random()));

function errorCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  return error?.cause?.code ?? error?.code ?? error?.name ?? 'ERROR';
}

class Client {
  constructor(label, clientIp) {
    this.label = label;
    this.clientIp = clientIp;
    this.cookies = new Map();
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

  async send(method, path, body) {
    const headers = {
      accept: 'application/json, text/event-stream',
      origin: config.origin,
      'x-forwarded-for': this.clientIp,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return fetch(config.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: 'manual',
    });
  }

  /**
   * One request as the person would see it. `retryDrain` sends a chat turn
   * refused by a draining replica again, as the web app does.
   */
  async request(name, method, path, { body, expect = [200], stream = false, retryDrain } = {}) {
    const at = Date.now();
    const started = performance.now();
    const event = { at, vu: this.label, name, method };
    let response;
    try {
      response = await this.send(method, path, body);
      for (let n = 0; retryDrain && n < 2 && response.status === 503; n++) {
        if (response.headers.get('retry-after') === null) break;
        await response.body?.cancel().catch(() => {});
        event.retried = `HTTP 503 draining x${n + 1}`;
        await sleep(1000);
        response = await this.send(method, path, body);
      }
    } catch (error) {
      Object.assign(event, {
        status: 0,
        ttfb: Math.round(performance.now() - started),
        outcome: 'fail',
        error: errorCode(error),
      });
      record(event);
      return { ok: false, status: 0, event };
    }
    event.status = response.status;
    event.ttfb = Math.round(performance.now() - started);
    event.retryable = response.headers.get('x-oci-retryable');
    this.keepCookies(response);
    const ok = expect.includes(response.status);
    if (ok && stream) {
      event.outcome = 'ok';
      return { ok, status: response.status, response, event };
    }
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      Object.assign(event, { outcome: 'fail', error: `BODY_${errorCode(error)}` });
      record(event);
      return { ok: false, status: response.status, event };
    }
    event.total = Math.round(performance.now() - started);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    event.outcome = ok ? 'ok' : 'fail';
    if (!ok) {
      event.error = response.status >= 500 ? 'HTTP_5XX' : `UNEXPECTED_${response.status}`;
      event.detail = String(json?.error?.message ?? json?.message ?? text).slice(0, 200);
    }
    record(event);
    return { ok, status: response.status, json, event };
  }
}

async function signIn(client, person) {
  client.cookies.clear();
  return client.request('sign-in', 'POST', '/api/auth/sign-in/email', {
    body: { email: person.email, password: config.password, rememberMe: true },
  });
}

async function sendMessage(client, vu) {
  const created = await client.request('thread.create', 'POST', '/api/threads', {
    body: { title: `Drill ${vu} ${new Date().toISOString()}` },
    expect: [201],
  });
  if (!created.ok) return;
  const threadId = created.json.thread.id;
  const startedAt = Date.now();
  const sent = await client.request('chat.send', 'POST', '/api/chat', {
    body: {
      threadId,
      modelSlug: config.modelSlug,
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: `Failover drill ${pick(config.words)} from ${vu}` }],
        },
      ],
    },
    stream: true,
    retryDrain: true,
  });
  if (!sent.ok) return;
  const reply = { vu, threadId, startedAt };
  activeReplies.add(reply);
  const read = await readUiStream(sent.response, { timeoutMs: config.replyTimeoutMs });
  sent.event.total = Date.now() - startedAt;
  record(sent.event);
  let outcome = read.complete ? 'complete' : read.errorText && !read.readError ? 'error' : 'cut';
  let resumed = null;
  if (outcome === 'cut') {
    // What the web app does after a dropped stream: ask for the rest.
    await sleep(500);
    const resume = await client.request('chat.resume', 'GET', `/api/chat/${threadId}/stream`, {
      expect: [200, 204],
      stream: true,
    });
    if (resume.ok && resume.status === 200) {
      const rest = await readUiStream(resume.response, { timeoutMs: config.replyTimeoutMs });
      record(resume.event);
      resumed = rest.complete ? 'finished' : 'ended';
      if (rest.complete) outcome = 'resumed';
    } else if (resume.ok) {
      record(resume.event);
      resumed = 'nothing-to-resume';
    }
  }
  activeReplies.delete(reply);
  counters.replies++;
  out.write(
    `${JSON.stringify({
      type: 'reply',
      vu,
      threadId,
      startedAt,
      endedAt: Date.now(),
      outcome,
      streamError: read.errorText ?? read.readError,
      deltas: read.deltas,
      resumed,
    })}\n`,
  );
}

async function virtualUser(index) {
  const person = config.people[index % config.people.length];
  const vu = `vu${index + 1}`;
  const client = new Client(vu, `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`);
  await sleep(index * 250);
  let signedIn = false;
  let iteration = 0;
  while (!stopping) {
    iteration++;
    if (!signedIn) {
      signedIn = (await signIn(client, person)).ok;
      if (!signedIn) {
        await sleep(1000);
        continue;
      }
    }
    const me = await client.request('me', 'GET', '/api/me');
    if (me.status === 401) signedIn = false;
    await client.request('sidebar.threads', 'GET', '/api/threads?view=sidebar');
    await think();
    if (stopping) break;
    const threadId = pick(person.threads);
    await client.request('thread.open', 'GET', `/api/threads/${threadId}`);
    await client.request('thread.messages', 'GET', `/api/chat/${threadId}/messages`);
    await think();
    if (stopping) break;
    if (iteration % config.sendEvery === 0) {
      await sendMessage(client, vu);
      await think();
    }
    if (stopping) break;
    if (iteration % 2 === 0) {
      const q = encodeURIComponent(pick(config.words));
      await client.request('search', 'GET', `/api/threads/search?q=${q}&limit=10`);
      await think();
    }
  }
}

process.on('message', (message) => {
  if (message?.type === 'stop') stopping = true;
  if (message?.type === 'status') {
    process.send?.({ type: 'status', counters, activeReplies: activeReplies.size });
  }
});

await Promise.all(Array.from({ length: config.vus }, (_, i) => virtualUser(i)));
await new Promise((resolve) => out.end(resolve));
process.send?.({ type: 'done', counters });
process.exit(0);

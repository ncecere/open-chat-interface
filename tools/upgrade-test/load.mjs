/**
 * Steady synthetic load for the rolling-upgrade test, run as a child process
 * of run.mjs (IPC). Each virtual user is one seeded person who signs in, loads
 * the sidebar, opens a conversation, sends a message to the stub model and
 * reads the reply to the end, and searches, with a short pause between steps.
 *
 * Every request is written to `events.ndjson` with its phase, status, time to
 * headers (`ttfb`, the latency the verdict bounds) and total time. Replies are
 * written as `reply` events: complete, resumed (cut, then finished through
 * GET /api/chat/:id/stream as the web app does) or cut.
 *
 * Usage: node load.mjs <config.json>   (config written by run.mjs)
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { Client, MODEL_SLUG, readUiStream, signIn, sleep } from './lib.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = createWriteStream(config.eventsFile, { flags: 'a' });
/** Phase changes with their times, so a request is tagged with the phase it started in. */
const phases = [{ name: 'warmup', at: 0 }];
const phaseAt = (at) => phases.findLast((p) => p.at <= at)?.name ?? 'warmup';
let stopping = false;
const counters = { requests: 0, failures: 0, replies: 0, cut: 0 };
const activeReplies = new Set();
/** Web entry points the runner has drained before replacing them. */
const drained = new Set();

function record(event) {
  event.phase = phaseAt(event.at);
  counters.requests++;
  if (event.outcome === 'fail') counters.failures++;
  out.write(`${JSON.stringify(event)}\n`);
}

function recordReply(event) {
  out.write(`${JSON.stringify({ type: 'reply', phase: phaseAt(event.startedAt), ...event })}\n`);
}

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const think = () => sleep(config.thinkMs * (0.5 + Math.random()));

async function sendMessage(client, vu) {
  const created = await client.request('thread.create', 'POST', '/api/threads', {
    body: { title: `Load ${vu} ${new Date().toISOString()}` },
    expect: [201],
  });
  if (!created.ok) return;
  const threadId = created.json.thread.id;
  const startedAt = Date.now();
  const sent = await client.request('chat.send', 'POST', '/api/chat', {
    body: {
      threadId,
      modelSlug: MODEL_SLUG,
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: `Rolling upgrade check ${pick(config.words)} from ${vu}` }],
        },
      ],
    },
    stream: true,
    // A replica shutting down refuses the turn before storing it; the web app
    // sends it again, and so does the load.
    retryDrain: true,
  });
  if (!sent.ok) return;
  const reply = { vu, threadId, startedAt, ttfb: sent.event.ttfb };
  activeReplies.add(reply);
  const read = await readUiStream(sent.response, { timeoutMs: config.replyTimeoutMs });
  const streamEndedAt = Date.now();
  sent.event.total = Date.now() - startedAt;
  // The request itself succeeded (headers arrived); the reply is judged below.
  record(sent.event);
  // An `error` event is the server reporting a failed reply; anything else
  // short of `finish` is the stream being cut.
  let outcome = read.complete ? 'complete' : read.errorText && !read.readError ? 'error' : 'cut';
  let resumed = null;
  let resumeMs = null;
  if (outcome === 'cut') {
    // What the web app does after a dropped stream: ask for the rest.
    await sleep(500);
    const resumeAt = Date.now();
    const resume = await client.request('chat.resume', 'GET', `/api/chat/${threadId}/stream`, {
      expect: [200, 204],
      stream: true,
      // A resumed reply may stream as long as a reply; the request timeout
      // would otherwise cut the body after 30 s.
      timeoutMs: config.replyTimeoutMs,
    });
    if (resume.ok && resume.status === 200) {
      const rest = await readUiStream(resume.response, { timeoutMs: config.replyTimeoutMs });
      resume.event.total = Date.now() - resume.event.at;
      record(resume.event);
      // `hung`: the resumed stream was still open when the load gave up on it.
      resumed = rest.complete ? 'finished' : rest.readError ? 'hung' : 'ended';
      if (rest.complete) outcome = 'resumed';
      resumeMs = Date.now() - resumeAt;
    } else if (resume.ok) {
      resume.event.total = resume.event.ttfb;
      record(resume.event);
      resumed = 'nothing-to-resume';
    }
  }
  // What was stored, which is what the person sees after a reload.
  const stored = await client.request('chat.messages', 'GET', `/api/chat/${threadId}/messages`);
  const last = stored.json?.messages?.at(-1);
  activeReplies.delete(reply);
  counters.replies++;
  if (outcome === 'cut') counters.cut++;
  recordReply({
    vu,
    threadId,
    startedAt,
    streamEndedAt,
    endedAt: Date.now(),
    outcome,
    streamFinished: read.finished,
    streamError: read.errorText ?? read.readError,
    deltas: read.deltas,
    resumed,
    resumeMs,
    storedStatus: last?.role === 'assistant' ? last.metadata?.status : (last?.role ?? null),
    storedError: last?.role === 'assistant' ? (last.metadata?.errorMessage ?? null) : null,
  });
}

async function virtualUser(index) {
  const person = config.people[index % config.people.length];
  const vu = `vu${index + 1}`;
  const client = new Client({
    bases: config.bases,
    origin: config.origin,
    record,
    timeoutMs: config.requestTimeoutMs,
    label: vu,
    drained,
    clientIp: `198.18.${Math.floor(index / 250)}.${(index % 250) + 1}`,
  });
  await sleep(index * 300);
  let iteration = 0;
  let signedIn = false;
  while (!stopping) {
    iteration++;
    if (!signedIn || iteration % config.signInEvery === 0) {
      client.cookies.clear();
      signedIn = (await signIn(client, person.email, config.password)).ok;
      if (!signedIn) {
        await sleep(1000);
        continue;
      }
    }
    await client.request('me', 'GET', '/api/me');
    await client.request('sidebar.threads', 'GET', '/api/threads?view=sidebar');
    await client.request('sidebar.projects', 'GET', '/api/projects/sidebar');
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
  if (message?.type === 'phase') phases.push({ name: message.name, at: Date.now() });
  if (message?.type === 'stop') stopping = true;
  if (message?.type === 'drain') drained.add(message.base);
  if (message?.type === 'undrain') drained.delete(message.base);
  if (message?.type === 'status') {
    process.send?.({
      type: 'status',
      counters,
      activeReplies: [...activeReplies].map((r) => ({ vu: r.vu, startedAt: r.startedAt })),
    });
  }
});

const users = Array.from({ length: config.vus }, (_, i) => virtualUser(i));
await Promise.all(users);
await new Promise((resolve) => out.end(resolve));
process.send?.({ type: 'done', counters });
process.exit(0);

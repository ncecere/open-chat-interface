#!/usr/bin/env node
/**
 * Stub OpenAI-compatible model provider for the scale harness.
 *
 * - POST /v1/chat/completions: streams `STUB_REPLY_TOKENS` tokens after
 *   `STUB_FIRST_TOKEN_MS`, at `STUB_TOKENS_PER_SECOND`; answers non-streaming
 *   requests (titles, summaries) after the first-token delay.
 * - POST /v1/embeddings: the deterministic hashing embedding the generator
 *   used for stored passages (lib/embed.mjs), after `STUB_EMBEDDING_DELAY_MS`.
 * - GET /marks/:id: when the request carrying `[scale:<id>]` in its text
 *   arrived and when its first and last tokens were sent, so the load test can
 *   split a reply's latency into OCI's part and the model's part.
 * - GET /stats, GET /health.
 *
 * No prompt content is logged or stored, only the marker and timings.
 * Grown from apps/api/test/browser-performance/provider.ts.
 */
import { createServer } from 'node:http';
import { approximateTokens, embedText } from '../lib/embed.mjs';
import { Rng } from '../lib/prng.mjs';
import { assistantMarkdown } from '../lib/text.mjs';

const config = {
  port: Number(process.env.STUB_PORT ?? 4181),
  firstTokenMs: Number(process.env.STUB_FIRST_TOKEN_MS ?? 500),
  tokensPerSecond: Number(process.env.STUB_TOKENS_PER_SECOND ?? 50),
  replyTokens: Number(process.env.STUB_REPLY_TOKENS ?? 250),
  embeddingDelayMs: Number(process.env.STUB_EMBEDDING_DELAY_MS ?? 40),
};
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_MARKS = 200_000;
const MARKER = /\[scale:([A-Za-z0-9_-]{1,64})\]/g;

// A few fixed replies, split into ~4-character tokens.
const REPLIES = Array.from({ length: 16 }, (_, i) => {
  const text = assistantMarkdown(new Rng(0x5eed, 99, i), config.replyTokens * 4);
  const tokens = [];
  for (let o = 0; o < text.length && tokens.length < config.replyTokens; o += 4) {
    tokens.push(text.slice(o, o + 4));
  }
  return tokens;
});

const stats = {
  started: new Date().toISOString(),
  config,
  chatRequests: 0,
  streamingRequests: 0,
  nonStreamingRequests: 0,
  embeddingRequests: 0,
  embeddedInputs: 0,
  activeStreams: 0,
  maxActiveStreams: 0,
  completedStreams: 0,
  cancelledStreams: 0,
  rejected: 0,
  promptCharsTotal: 0,
};
const marks = new Map();

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function remember(id, value) {
  if (marks.size >= MAX_MARKS) marks.delete(marks.keys().next().value);
  marks.set(id, value);
}

/** The marker in the newest user message, if any. */
function markerOf(raw) {
  let last = null;
  for (const match of raw.matchAll(MARKER)) last = match[1];
  return last;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(request, response, receivedAt) {
  stats.chatRequests++;
  const raw = await readBody(request);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    stats.rejected++;
    json(response, 400, { error: { message: 'Invalid JSON' } });
    return;
  }
  const promptChars = raw.length;
  stats.promptCharsTotal += promptChars;
  const marker = markerOf(raw);
  const mark = marker ? { receivedAt, promptChars, firstTokenAt: null, lastTokenAt: null } : null;
  if (marker) remember(marker, mark);
  const model = typeof body.model === 'string' ? body.model : 'scale-stub';
  const reply = REPLIES[(stats.chatRequests * 7) % REPLIES.length];
  const usage = {
    prompt_tokens: approximateTokens(raw),
    completion_tokens: reply.length,
    total_tokens: approximateTokens(raw) + reply.length,
  };
  const common = {
    id: `chatcmpl-scale-${stats.chatRequests}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };

  if (!body.stream) {
    stats.nonStreamingRequests++;
    await sleep(config.firstTokenMs);
    json(response, 200, {
      ...common,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply.join('') },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
    return;
  }

  stats.streamingRequests++;
  stats.activeStreams++;
  stats.maxActiveStreams = Math.max(stats.maxActiveStreams, stats.activeStreams);
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.flushHeaders();
  let closed = false;
  response.once('close', () => {
    closed = true;
  });
  const send = (choices, extra) => {
    response.write(
      `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices, ...extra })}\n\n`,
    );
  };
  try {
    await sleep(config.firstTokenMs);
    if (closed) throw new Error('closed');
    send([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    const interval = 1000 / Math.max(1, config.tokensPerSecond);
    const started = Date.now();
    for (let i = 0; i < reply.length; i++) {
      // Paced against the start, so timer drift does not slow the stream.
      const due = started + i * interval - Date.now();
      if (due > 0) await sleep(due);
      if (closed) throw new Error('closed');
      send([{ index: 0, delta: { content: reply[i] }, finish_reason: null }]);
      if (i === 0 && mark) mark.firstTokenAt = Date.now();
    }
    send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    send([], { usage });
    if (mark) mark.lastTokenAt = Date.now();
    response.end('data: [DONE]\n\n');
    stats.completedStreams++;
  } catch {
    stats.cancelledStreams++;
    if (!response.destroyed) response.destroy();
  } finally {
    stats.activeStreams--;
  }
}

async function embeddings(request, response) {
  stats.embeddingRequests++;
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    stats.rejected++;
    json(response, 400, { error: { message: 'Invalid JSON' } });
    return;
  }
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (!inputs.every((input) => typeof input === 'string')) {
    stats.rejected++;
    json(response, 400, { error: { message: 'input must be a string or an array of strings' } });
    return;
  }
  const dimensions = Number.isInteger(body.dimensions) ? body.dimensions : 1536;
  stats.embeddedInputs += inputs.length;
  await sleep(config.embeddingDelayMs);
  let tokens = 0;
  const data = inputs.map((input, index) => {
    tokens += approximateTokens(input);
    return { object: 'embedding', index, embedding: Array.from(embedText(input, dimensions)) };
  });
  json(response, 200, {
    object: 'list',
    data,
    model: body.model ?? 'scale-embed',
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  });
}

const server = createServer((request, response) => {
  const receivedAt = Date.now();
  const url = new URL(request.url ?? '/', 'http://stub');
  const handle = async () => {
    if (request.method === 'GET' && url.pathname === '/health')
      return json(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/stats') return json(response, 200, stats);
    if (request.method === 'GET' && url.pathname.startsWith('/marks/')) {
      const mark = marks.get(decodeURIComponent(url.pathname.slice('/marks/'.length)));
      return mark ? json(response, 200, mark) : json(response, 404, { error: 'unknown mark' });
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return json(response, 200, {
        object: 'list',
        data: ['scale-stub', 'scale-mini', 'scale-reasoning', 'scale-large', 'scale-embed'].map(
          (id) => ({ id, object: 'model', owned_by: 'scale-harness' }),
        ),
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return chat(request, response, receivedAt);
    }
    if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
      return embeddings(request, response);
    }
    return json(response, 404, { error: { message: 'Unknown stub endpoint' } });
  };
  handle().catch(() => {
    if (response.headersSent) response.destroy();
    else json(response, 500, { error: { message: 'Stub error' } });
  });
});

server.keepAliveTimeout = 65_000;
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Scale stub model listening on :${config.port} ${JSON.stringify(config)}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}

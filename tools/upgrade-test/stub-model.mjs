// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone container script, never a Turbo task.
/**
 * A stub OpenAI-compatible model for the rolling-upgrade test. Every chat
 * completion streams the same text in STUB_CHUNKS chunks, STUB_CHUNK_MS apart,
 * so a reply takes a known time and is reliably in flight while a replica is
 * replaced. No outbound I/O; prompts are never logged.
 *
 * Adapted from apps/api/test/browser-performance/provider.ts (plain .mjs so it
 * runs in a stock node:22-alpine container without a build).
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4181);
const CHUNKS = Number(process.env.STUB_CHUNKS ?? 40);
const CHUNK_MS = Number(process.env.STUB_CHUNK_MS ?? 100);
const INITIAL_MS = Number(process.env.STUB_INITIAL_MS ?? 150);

const WORDS = 'upgrade rolling replica schema migration latency stream reply'.split(' ');
const TEXT = Array.from(
  { length: CHUNKS },
  (_, i) => `${WORDS[i % WORDS.length]} chunk ${i + 1} of the stub reply. `,
).join('');
const USAGE = { prompt_tokens: 64, completion_tokens: 256, total_tokens: 320 };
const stats = { requests: 0, streams: 0, completed: 0, cancelled: 0 };
/** Streams being written, by the API replica's address, so the runner can stop a busy one. */
const active = new Map();

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/stats')) {
      return json(res, 200, stats);
    }
    if (req.method === 'GET' && req.url === '/active') {
      return json(res, 200, [...active.values()]);
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: 'upgrade-stub', object: 'model' }],
      });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      return json(res, 404, { error: { message: 'unknown endpoint' } });
    }
    stats.requests++;
    const body = await readJson(req);
    const common = {
      id: `chatcmpl-upgrade-${stats.requests}`,
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'upgrade-stub',
    };
    if (!body.stream) {
      return json(res, 200, {
        ...common,
        object: 'chat.completion',
        // Short, so title generation and summaries are cheap.
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Stub title' },
            finish_reason: 'stop',
          },
        ],
        usage: USAGE,
      });
    }
    stats.streams++;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (choices, usage) =>
      res.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices, ...(usage && { usage }) })}\n\n`,
      );
    let index = 0;
    let timer;
    let done = false;
    const key = Symbol('stream');
    active.set(key, {
      ip: req.socket.remoteAddress?.replace(/^::ffff:/, ''),
      startedAt: Date.now(),
    });
    res.on('close', () => {
      active.delete(key);
      clearInterval(timer);
      if (!done) stats.cancelled++;
    });
    await new Promise((resolve) => setTimeout(resolve, INITIAL_MS));
    if (res.destroyed) return;
    send([
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      },
    ]);
    timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      const start = Math.floor((index * TEXT.length) / CHUNKS);
      const end = Math.floor(((index + 1) * TEXT.length) / CHUNKS);
      send([
        {
          index: 0,
          delta: { content: TEXT.slice(start, end) },
          finish_reason: null,
        },
      ]);
      index++;
      if (index >= CHUNKS) {
        clearInterval(timer);
        send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
        send([], USAGE);
        done = true;
        stats.completed++;
        res.end('data: [DONE]\n\n');
      }
    }, CHUNK_MS);
  })().catch(() => {
    if (!res.headersSent) json(res, 500, { error: { message: 'stub error' } });
    else res.destroy();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`stub model listening on ${PORT} (${CHUNKS} chunks x ${CHUNK_MS} ms)`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));

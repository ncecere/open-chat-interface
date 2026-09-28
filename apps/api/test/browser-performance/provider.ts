import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const FIXTURE_MODEL = 'browser-fixture';
export const STREAM_CHUNKS = 100;
export const INITIAL_DELAY_MS = 150;
export const CHUNK_DELAY_MS = 40;

/** ASCII markdown, identical for every request; no prompt content is reflected. */
export const RESPONSE_MARKDOWN = Array.from(
  { length: 32 },
  (_, index) => `## Local fixture section ${String(index + 1).padStart(2, '0')}

This is a deterministic browser rendering sample, not an inference result. It exercises **bold text**, *emphasis*, inline \`code\`, lists, tables, and fenced code while a real chat stream is persisted locally.

- Keep the conversation readable during incremental updates.
- Compare the same fixed content and timing in each browser build.

| Metric | Value | Meaning |
| --- | ---: | --- |
| Samples | 100 | Synthetic chunks |
| Delay | 40 | Milliseconds per chunk |

\`\`\`typescript
const sample = { section: ${index + 1}, source: 'local-fixture' };
console.log(sample.section);
\`\`\`

`,
).join('');

// These counts are deliberately synthetic, not a tokenizer's accounting.
const USAGE = { prompt_tokens: 512, completion_tokens: 5_000, total_tokens: 5_512 };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Creates, but does not listen on, a loopback-only fixture server. No outbound I/O. */
export function createFixtureProvider(
  timing: { initialDelayMs?: number; chunkDelayMs?: number } = {},
) {
  const stats = {
    requests: 0,
    streamingRequests: 0,
    nonStreamingRequests: 0,
    activeStreams: 0,
    completedStreams: 0,
    cancelledStreams: 0,
    rejectedRequests: 0,
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'GET' && request.url === '/stats') {
      json(response, 200, stats);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      json(response, 404, { error: { message: 'Unknown fixture endpoint' } });
      return;
    }

    stats.requests++;
    const sequence = stats.requests;
    let body: unknown;
    try {
      body = await readBody(request);
    } catch {
      stats.rejectedRequests++;
      if (!response.destroyed) json(response, 400, { error: { message: 'Invalid request body' } });
      return;
    }
    if (!body || typeof body !== 'object' || !('model' in body) || body.model !== FIXTURE_MODEL) {
      stats.rejectedRequests++;
      json(response, 400, { error: { message: 'Only browser-fixture is available' } });
      return;
    }
    if ('stream' in body && typeof body.stream !== 'boolean') {
      stats.rejectedRequests++;
      json(response, 400, { error: { message: 'stream must be a boolean' } });
      return;
    }
    const common = {
      id: `chatcmpl-browser-fixture-${sequence}`,
      created: 1_735_689_600,
      model: FIXTURE_MODEL,
    };
    if (!('stream' in body) || !body.stream) {
      stats.nonStreamingRequests++;
      json(response, 200, {
        ...common,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: RESPONSE_MARKDOWN },
            finish_reason: 'stop',
          },
        ],
        usage: USAGE,
      });
      return;
    }

    if (response.destroyed) return;
    stats.streamingRequests++;
    stats.activeStreams++;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let interval: ReturnType<typeof setInterval> | undefined;
    let initial: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(initial);
      clearInterval(interval);
      stats.activeStreams--;
      if (!finished) stats.cancelledStreams++;
    };
    response.once('close', cleanup);
    response.once('error', cleanup);
    const event = (choices: unknown[], usage?: typeof USAGE) => {
      response.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices, ...(usage && { usage }) })}\n\n`,
      );
    };
    let index = 0;
    const tick = () => {
      if (response.destroyed || cleaned) {
        cleanup();
        return;
      }
      const start = Math.floor((index * RESPONSE_MARKDOWN.length) / STREAM_CHUNKS);
      const end = Math.floor(((index + 1) * RESPONSE_MARKDOWN.length) / STREAM_CHUNKS);
      event([
        { index: 0, delta: { content: RESPONSE_MARKDOWN.slice(start, end) }, finish_reason: null },
      ]);
      index++;
      if (index === STREAM_CHUNKS) {
        event([{ index: 0, delta: {}, finish_reason: 'stop' }]);
        event([], USAGE);
        finished = true;
        stats.completedStreams++;
        cleanup();
        response.end('data: [DONE]\n\n');
      }
    };
    initial = setTimeout(() => {
      if (response.destroyed || cleaned) {
        cleanup();
        return;
      }
      event([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
      tick();
      interval = setInterval(tick, timing.chunkDelayMs ?? CHUNK_DELAY_MS);
    }, timing.initialDelayMs ?? INITIAL_DELAY_MS);
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Never print request bodies, authorization headers, or parser errors.
      if (response.headersSent) response.destroy();
      else if (!response.destroyed) json(response, 500, { error: { message: 'Fixture error' } });
    });
  });
}

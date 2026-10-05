import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenAI-compatible model server that enforces a provider's limits the
 * way providers do: requests over its concurrent-stream or per-minute limit
 * are refused with `429` and `Retry-After`. Loopback only; no outbound I/O.
 */
export interface StubLimits {
  maxConcurrent?: number;
  requestsPerMinute?: number;
  /** Seconds sent in Retry-After. */
  retryAfterSeconds?: number;
  /** Refuse this many requests first, whatever the load (for retry tests). */
  refuseFirst?: number;
  chunks?: number;
  chunkDelayMs?: number;
  /** Send an error event after this many chunks instead of finishing. */
  failAfterChunks?: number;
}

export interface StubStats {
  requests: number;
  accepted: number;
  refused: number;
  active: number;
  maxActive: number;
  /** The latest user message of each accepted request, in order. */
  started: string[];
  completed: string[];
}

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  const last = messages?.filter((message) => message.role === 'user').at(-1);
  if (typeof last?.content === 'string') return last.content;
  if (Array.isArray(last?.content))
    return last.content
      .map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  return '';
}

export async function startRateLimitedProvider(initial: StubLimits = {}) {
  let limits: StubLimits = { ...initial };
  const stats: StubStats = {
    requests: 0,
    accepted: 0,
    refused: 0,
    active: 0,
    maxActive: 0,
    started: [],
    completed: [],
  };
  const window: number[] = [];

  const refuse = (response: ServerResponse) => {
    stats.refused++;
    response.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(limits.retryAfterSeconds ?? 1),
    });
    response.end(
      JSON.stringify({
        error: { message: 'Rate limit reached', type: 'rate_limit_exceeded', code: '429' },
      }),
    );
  };

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    stats.requests++;
    const now = Date.now();
    while (window.length && window[0]! <= now - 60_000) window.shift();
    if (limits.refuseFirst && limits.refuseFirst > 0) {
      limits.refuseFirst--;
      refuse(response);
      return;
    }
    if (
      (limits.maxConcurrent !== undefined && stats.active >= limits.maxConcurrent) ||
      (limits.requestsPerMinute !== undefined && window.length >= limits.requestsPerMinute)
    ) {
      refuse(response);
      return;
    }
    window.push(now);
    const text = lastUserText(body);
    stats.accepted++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    stats.started.push(text);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      stats.active--;
    };
    response.once('close', done);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const common = { id: `stub-${stats.requests}`, created: 1_735_689_600, model: body.model };
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const total = limits.chunks ?? 4;
    const failAfter = limits.failAfterChunks;
    for (let index = 0; index < total; index++) {
      await new Promise((resolve) => setTimeout(resolve, limits.chunkDelayMs ?? 50));
      if (response.destroyed) return done();
      if (failAfter !== undefined && index === failAfter) {
        send({ error: { message: 'Overloaded', type: 'overloaded_error', code: 529 } });
        response.end();
        return done();
      }
      send({
        ...common,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: `part${index} ` }, finish_reason: null }],
      });
    }
    send({
      ...common,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: total, total_tokens: 10 + total },
    });
    response.write('data: [DONE]\n\n');
    response.end();
    stats.completed.push(text);
    done();
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stats,
    configure(next: StubLimits) {
      limits = { ...next };
    },
    reset() {
      Object.assign(stats, {
        requests: 0,
        accepted: 0,
        refused: 0,
        active: 0,
        maxActive: 0,
        started: [],
        completed: [],
      });
      window.length = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

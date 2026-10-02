import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Cohere-compatible reranking server on 127.0.0.1 for tests. It answers
 * `POST <prefix>/rerank` with `{ results: [{ index, relevance_score }] }`,
 * scoring each document with `score` (by default: how many of the query's
 * words it contains), and records every request it receives.
 */
export interface FakeRerankRequest {
  path: string;
  authorization: string | undefined;
  body: { model?: string; query?: string; documents?: string[]; top_n?: number };
}

export interface FakeReranker {
  /** Base URL to store on a provider, such as `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  requests: FakeRerankRequest[];
  /** Scores one document for a query; higher is better. */
  score: (query: string, document: string) => number;
  /** `ok` answers, `error` answers HTTP 500, `hang` never answers. */
  mode: 'ok' | 'error' | 'hang';
  /** Reported as `usage.total_tokens` when set. */
  tokens: number | null;
  /** Answers with at most this many results, whatever `top_n` asked for. */
  maxResults: number | null;
  close: () => Promise<void>;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

export function overlapScore(query: string, document: string): number {
  const wanted = new Set(words(query));
  return words(document).filter((word) => wanted.has(word)).length;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeReranker(prefix = '/v1'): Promise<FakeReranker> {
  const hanging = new Set<() => void>();
  const fake: FakeReranker = {
    baseUrl: '',
    requests: [],
    score: overlapScore,
    mode: 'ok',
    tokens: null,
    maxResults: null,
    close: async () => {},
  };
  const server: Server = createServer(async (request, response) => {
    const raw = await readBody(request);
    let body: FakeRerankRequest['body'] = {};
    try {
      body = JSON.parse(raw) as FakeRerankRequest['body'];
    } catch {
      // Recorded as an empty body.
    }
    fake.requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body,
    });
    if (request.method !== 'POST' || request.url !== `${prefix}/rerank`) {
      response.writeHead(404).end();
      return;
    }
    if (fake.mode === 'hang') {
      // Answered only when the server closes.
      hanging.add(() => response.destroy());
      return;
    }
    if (fake.mode === 'error') {
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    const documents = body.documents ?? [];
    const results = documents
      .map((document, index) => ({
        index,
        relevance_score: fake.score(body.query ?? '', document),
        document: { text: document },
      }))
      .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
      .slice(0, Math.min(body.top_n ?? documents.length, fake.maxResults ?? documents.length));
    response.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        id: 'fake',
        results,
        ...(fake.tokens !== null && { usage: { total_tokens: fake.tokens } }),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  fake.baseUrl = `http://127.0.0.1:${port}${prefix}`;
  fake.close = async () => {
    for (const end of hanging) end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}

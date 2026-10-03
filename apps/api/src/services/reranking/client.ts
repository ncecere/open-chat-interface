import { RERANK_TIMEOUT_MS } from '@oci/shared';
import { providerError } from '../../lib/errors.js';

/**
 * A small client for the Cohere-compatible reranking API, served by Cohere,
 * Jina, vLLM and LiteLLM gateways:
 *
 *   POST <base URL>/rerank
 *   { "model", "query", "documents": string[], "top_n" }
 *   → { "results": [{ "index", "relevance_score" }, ...] }
 *
 * Responses are accepted in that shape (Cohere's v1 and v2 APIs share it;
 * Jina and vLLM add the document and token usage) and in Hugging Face TEI's
 * bare `[{ "index", "score" }]`. No new dependency: one `fetch` with a timeout
 * and a cap on the response size.
 *
 * Failures name the provider and never include the API key (it only travels
 * in the Authorization header) or the query.
 */

/** Far more than 40 scored documents need, even when a server echoes each document. */
export const MAX_RERANK_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RerankRequest {
  /** The full `.../rerank` URL. */
  endpoint: string;
  /** Bearer token; omitted when null (a local server without authentication). */
  apiKey: string | null;
  /** The provider's label, used in error messages. */
  provider: string;
  model: string;
  query: string;
  documents: string[];
  /** How many results to ask for; defaults to every document. */
  topN?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RerankScore {
  /** Position of the document in the request. */
  index: number;
  score: number;
}

export interface RerankResult {
  /** Documents the model scored, best first; each index appears once. */
  ranking: RerankScore[];
  /** Tokens the provider reported, or 0 when it reported none. */
  tokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Token usage as Jina and vLLM (`usage`) or Cohere and LiteLLM (`meta`) report it. */
function reportedTokens(body: unknown): number {
  if (!isRecord(body)) return 0;
  const usage = isRecord(body.usage) ? body.usage : {};
  const meta = isRecord(body.meta) ? body.meta : {};
  const billed = isRecord(meta.billed_units) ? meta.billed_units : {};
  const tokens = isRecord(meta.tokens) ? meta.tokens : {};
  return (
    positiveInteger(usage.total_tokens) ||
    positiveInteger(billed.input_tokens) ||
    positiveInteger(tokens.input_tokens)
  );
}

/**
 * The scored documents of a reranking response, best first. Every index must
 * name a document that was sent and every score must be a finite number;
 * anything else means the server is not a reranker, so it is an error rather
 * than something to repair. A repeated index keeps its first score.
 */
export function parseRerankResponse(body: unknown, documents: number): RerankScore[] | null {
  const list = Array.isArray(body) ? body : isRecord(body) ? body.results : undefined;
  if (!Array.isArray(list)) return null;
  const seen = new Set<number>();
  const ranking: RerankScore[] = [];
  for (const item of list) {
    if (!isRecord(item)) return null;
    const { index } = item;
    const score = item.relevance_score ?? item.score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documents) {
      return null;
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) return null;
    if (seen.has(index)) continue;
    seen.add(index);
    ranking.push({ index, score });
  }
  return ranking.sort((a, b) => b.score - a.score || a.index - b.index);
}

/** Reads at most `limit` bytes of a body; null when it is longer. */
async function readBounded(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function statusError(provider: string, status: number, endpoint: string) {
  if (status === 401 || status === 403) {
    return providerError(`${provider} rejected the API key for reranking (HTTP ${status}).`);
  }
  if (status === 404) {
    return providerError(`${provider} has no reranking endpoint at ${endpoint} (HTTP 404).`);
  }
  if (status === 429) {
    return providerError(
      `${provider} refused to rerank because a rate limit was reached (HTTP 429).`,
    );
  }
  return providerError(`${provider} returned an error while reranking (HTTP ${status}).`);
}

/**
 * Sends one reranking request. Throws an `AppError` naming the provider when
 * it cannot be reached, does not answer within the timeout (five seconds by
 * default, body included), answers with an error, or answers with something
 * that is not reranking results or is larger than the size limit.
 */
export async function rerank(request: RerankRequest): Promise<RerankResult> {
  if (request.documents.length === 0) return { ranking: [], tokens: 0 };
  const timeoutMs = request.timeoutMs ?? RERANK_TIMEOUT_MS;
  const limit = request.maxResponseBytes ?? MAX_RERANK_RESPONSE_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  const tooSlow = () =>
    providerError(`${request.provider} did not rerank within ${timeoutMs / 1000} s.`);

  let response: Response;
  try {
    // The endpoint is derived from an administrator-managed provider base URL.
    // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
    response = await fetch(request.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(request.apiKey && { authorization: `Bearer ${request.apiKey}` }),
      },
      body: JSON.stringify({
        model: request.model,
        query: request.query,
        documents: request.documents,
        top_n: Math.min(request.topN ?? request.documents.length, request.documents.length),
      }),
      signal,
    });
  } catch (error) {
    if (isTimeout(error, signal)) throw tooSlow();
    throw providerError(`${request.provider} could not be reached for reranking.`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw statusError(request.provider, response.status, request.endpoint);
  }

  let text: string | null;
  try {
    text = await readBounded(response, limit);
  } catch (error) {
    if (isTimeout(error, signal)) throw tooSlow();
    throw providerError(`${request.provider} could not be reached for reranking.`);
  }
  if (text === null) {
    throw providerError(
      `${request.provider} returned a reranking response larger than ${Math.floor(limit / 1024)} KB.`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const ranking = parseRerankResponse(body, request.documents.length);
  if (!ranking) {
    throw providerError(`${request.provider} returned a response that is not reranking results.`);
  }
  return { ranking, tokens: reportedTokens(body) };
}

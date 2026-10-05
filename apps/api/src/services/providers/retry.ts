import type { LanguageModel, LanguageModelMiddleware } from 'ai';

/**
 * Sending a model request again when the provider refuses it for now (v0.11
 * design, item 15): 429 (rate limited), 408, 409, 5xx and "overloaded".
 *
 * Only before the reply's first output: a request that failed before
 * answering, or whose stream's first event (after its opening metadata) is
 * such an error. Once any text, reasoning or tool call has been read the
 * error is passed on as it came, so nothing streamed is ever repeated.
 *
 * The wait honours `retry-after-ms` and `Retry-After` (seconds or a date);
 * without either it doubles from one second, with jitter. Bounded: at most
 * `maxRetries` retries, and never past `budgetMs` in all (a wait longer than
 * what is left fails at once instead of waiting in vain).
 *
 * This replaces the AI SDK's own retries (streamText must run with
 * `maxRetries: 0`), which honour Retry-After too but cannot tell OCI's limiter
 * the provider is throttling, or retry an error that arrives as the stream's
 * first event.
 */

export interface RetryPolicy {
  maxRetries: number;
  budgetMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  budgetMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export interface Throttle {
  /** HTTP status, or 529/503 for an overload reported in the stream. */
  status: number;
  retryAfterMs: number | null;
  /** Whether it will be retried. */
  retrying: boolean;
}

export interface RetryHooks {
  signal?: AbortSignal;
  /** Before every provider request but the run's first (later tool steps, retries). */
  onExtraRequest?: () => void;
  onThrottle?: (throttle: Throttle) => void;
  /** Just before the run's first provider request is sent (service objectives). */
  onFirstRequest?: () => void;
  /** The run's first request (retries included) reached its first output, after `ms`. */
  onFirstOutput?: (ms: number) => void;
  policy?: Partial<RetryPolicy>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Statuses a provider uses for "not now". */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const RETRYABLE_TYPES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'rate_limit_exceeded',
  'server_error',
  'api_error',
]);

/**
 * The AI SDK's APICallError, recognised by its fields rather than `instanceof`
 * (or `APICallError.isInstance`), so no runtime import of the SDK is needed.
 */
function apiCallError(
  error: unknown,
): { statusCode?: number; isRetryable?: boolean; responseHeaders?: Record<string, string> } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { name?: unknown; isRetryable?: unknown; url?: unknown };
  return candidate.name === 'AI_APICallError' ||
    (typeof candidate.isRetryable === 'boolean' && typeof candidate.url === 'string')
    ? (error as never)
    : null;
}

/** The status of a retryable refusal, or null when the error is not one. */
export function retryableStatus(error: unknown): number | null {
  const api = apiCallError(error);
  if (api) {
    if (api.statusCode && RETRYABLE_STATUS.has(api.statusCode)) return api.statusCode;
    return api.isRetryable ? (api.statusCode ?? 503) : null;
  }
  // Errors inside a stream are the provider's JSON error object.
  const candidate = error as {
    type?: unknown;
    code?: unknown;
    status?: unknown;
    error?: { type?: unknown; code?: unknown };
  } | null;
  if (!candidate || typeof candidate !== 'object') return null;
  const status = Number(candidate.status ?? candidate.code);
  if (RETRYABLE_STATUS.has(status)) return status;
  const type = candidate.type ?? candidate.error?.type ?? candidate.error?.code ?? candidate.code;
  if (typeof type === 'string' && RETRYABLE_TYPES.has(type))
    return type === 'overloaded_error' ? 529 : type.startsWith('rate_limit') ? 429 : 503;
  return null;
}

/** Milliseconds the provider asked for, or null. */
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const headers = apiCallError(error)?.responseHeaders;
  if (!headers) return null;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const ms = Number.parseFloat(lower['retry-after-ms'] ?? '');
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = lower['retry-after'];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>;
type Part = StreamResult['stream'] extends ReadableStream<infer T> ? T : never;

/** Events a stream opens with, before any output. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'raw']);

/**
 * Reads a stream up to its first output. Returns the error that came first
 * instead, if one did, or a stream that replays what was read and goes on.
 */
async function peek(
  stream: ReadableStream<Part>,
): Promise<{ stream: ReadableStream<Part>; error?: unknown }> {
  const reader = stream.getReader();
  const buffered: Part[] = [];
  let firstError: unknown;
  let done = false;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    const part = next.value as { type: string; error?: unknown };
    buffered.push(next.value);
    if (PREAMBLE.has(part.type)) continue;
    if (part.type === 'error') firstError = part.error ?? part;
    break;
  }
  const replay = new ReadableStream<Part>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return firstError === undefined ? { stream: replay } : { stream: replay, error: firstError };
}

/**
 * The model with its `doStream` wrapped; everything else is the model's own
 * (a proxy, so the provider's class and specification version are kept).
 */
export function withProviderRetries(model: LanguageModel, hooks: RetryHooks = {}): LanguageModel {
  if (typeof model !== 'object' || model === null || typeof model.doStream !== 'function')
    return model;
  const policy = { ...DEFAULT_RETRY_POLICY, ...hooks.policy };
  const sleep = hooks.sleep ?? defaultSleep;
  let requests = 0;
  let outputSeen = false;
  const original = model.doStream.bind(model) as (params: unknown) => Promise<StreamResult>;
  const wrapStream = async (params: unknown): Promise<StreamResult> => {
    const doStream = () => original(params);
    const started = Date.now();
    for (let retries = 0; ; retries++) {
      if (requests++ > 0) hooks.onExtraRequest?.();
      else hooks.onFirstRequest?.();
      let error: unknown;
      let result: StreamResult | undefined;
      try {
        result = await doStream();
        const peeked = await peek(result.stream);
        result = { ...result, stream: peeked.stream };
        if (!('error' in peeked)) {
          if (!outputSeen) hooks.onFirstOutput?.(Date.now() - started);
          outputSeen = true;
          return result;
        }
        error = peeked.error;
      } catch (thrown) {
        error = thrown;
      }
      const status = retryableStatus(error);
      const asked = retryAfterMs(error);
      const delay =
        asked ??
        Math.min(
          policy.maxDelayMs,
          policy.baseDelayMs * 2 ** retries * (0.8 + Math.random() * 0.4),
        );
      const retrying =
        status !== null &&
        retries < policy.maxRetries &&
        !hooks.signal?.aborted &&
        Date.now() - started + delay <= policy.budgetMs;
      if (status !== null) hooks.onThrottle?.({ status, retryAfterMs: asked, retrying });
      if (!retrying) {
        // As it came: a thrown error throws, an error event stays in the stream.
        if (result) return result;
        throw error;
      }
      await result?.stream.cancel().catch(() => undefined);
      await sleep(delay, hooks.signal);
    }
  };
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === 'doStream') return wrapStream;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

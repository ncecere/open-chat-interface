import type { ApiErrorBody, ReadOnlyStatus } from '@oci/shared';
import { noteReadOnlyRefusal, readOnlyMessage } from '~/lib/read-only';
import { noteUnauthorized } from '~/lib/session-ended';
import { type FieldLabels, validationText } from '~/lib/validation-issues';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Only server API errors are suitable for display; other failures use
 * caller-specific copy. A validation failure names each field and rule rather
 * than "Request validation failed" (#127).
 */
export function apiErrorMessage(error: unknown, fallback: string, labels?: FieldLabels): string {
  return error instanceof ApiError
    ? validationText(error.details, error.message, labels)
    : fallback;
}

/**
 * The text of a failed chat request. The AI SDK puts the response body in the
 * error message, so an API error arrives as JSON; show only its message.
 */
export function chatErrorText(error: Error): string {
  try {
    const body = JSON.parse(error.message) as Partial<ApiErrorBody>;
    // A send that raced read-only maintenance mode (v0.11): say why, in the
    // person's own time zone, rather than show it as a failure.
    if ((body.error?.code as string | undefined) === 'READ_ONLY') {
      const status = (body.error?.details as { readOnly?: ReadOnlyStatus } | undefined)?.readOnly;
      return readOnlyMessage(
        status ?? { active: true, source: null, reason: null, until: null, window: null },
      );
    }
    if (typeof body.error?.message === 'string' && body.error.message) return body.error.message;
  } catch {
    // Not an API error body: the message is already text.
  }
  return error.message;
}

export function sameOriginApiUrl(path: string, origin: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new TypeError('API path must be a same-origin absolute path');
  }

  const url = new URL(`/api${path}`, origin);
  if (url.origin !== origin) throw new TypeError('API path must remain same-origin');
  return `${url.pathname}${url.search}`;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const url = sameOriginApiUrl(path, window.location.origin);
  // This executes in the browser and sameOriginApiUrl returns only a path on
  // window.location.origin; it cannot initiate a server-side request.
  // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    // A session that ended while the page was open: to sign-in (#165).
    if (response.status === 401) noteUnauthorized();
    let code = 'INTERNAL_ERROR';
    let message = response.statusText || 'Request failed';
    let details: unknown;

    try {
      const body = (await response.json()) as ApiErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details;
      // A write refused for read-only maintenance (423, v0.11): the banner,
      // composer and admin forms switch to read-only at once.
      if (response.status === 423 && noteReadOnlyRefusal(body)) {
        const status = (details as { readOnly?: ReadOnlyStatus } | undefined)?.readOnly;
        if (status) message = readOnlyMessage(status);
      }
    } catch {
      // Non-JSON error responses keep the status text.
    }

    throw new ApiError(response.status, code, message, details);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * The file name a `Content-Disposition` header suggests (`filename*=UTF-8''…`
 * first, then `filename="…"`), reduced to a bare name; null when there is none.
 */
export function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (extended) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(header);
    const value = plain?.[1] ?? plain?.[2];
    if (value !== undefined) name = value.replace(/\\(.)/g, '$1');
  }
  // Never a path: only the last segment, without control characters.
  const bare = name?.split(/[/\\]/).pop()?.replace(CONTROL_CHARACTERS, '').trim();
  return bare && bare !== '.' && bare !== '..' ? bare : null;
}

interface DownloadedFile {
  blob: Blob;
  /** The name from `Content-Disposition`, when the response has one. */
  filename: string | null;
}

export const api = {
  get: <T>(path: string, options?: Pick<RequestInit, 'signal'>) => request<T>(path, options),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** A file response as a blob; failures are ApiErrors with the API's message. */
  download: async (path: string): Promise<DownloadedFile> => {
    const response = await send(path);
    return {
      blob: await response.blob(),
      filename: dispositionFilename(response.headers.get('content-disposition')),
    };
  },
};

/** Saves a blob through a temporary object URL and link, as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked later: some browsers start reading the URL only after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

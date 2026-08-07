import type { ApiErrorBody } from '@oci/shared';

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

export function sameOriginApiUrl(path: string, origin: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) {
    throw new TypeError('API path must be a same-origin absolute path');
  }

  const url = new URL(`/api${path}`, origin);
  if (url.origin !== origin) throw new TypeError('API path must remain same-origin');
  return `${url.pathname}${url.search}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    let code = 'INTERNAL_ERROR';
    let message = response.statusText || 'Request failed';
    let details: unknown;

    try {
      const body = (await response.json()) as ApiErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details;
    } catch {
      // Non-JSON error responses keep the status text.
    }

    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

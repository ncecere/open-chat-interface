/**
 * When each request reached the metrics middleware (`performance.now()`),
 * for the reply-start objective (docs/dev/slo.md): a reply's time added by
 * OCI is measured from here, so authentication, rate limits and parsing
 * count. Keyed by the Request object, so nothing is kept after it is gone.
 */
const requestStarts = new WeakMap<Request, number>();

export function markRequestStart(request: Request, at: number): void {
  requestStarts.set(request, at);
}

/** When `request` arrived, or now when it was not observed (tests). */
export function requestStartedAt(request: Request): number {
  return requestStarts.get(request) ?? performance.now();
}

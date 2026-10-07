/**
 * A session that ends while the app is open (#165): an administrator bans the
 * person or signs them out everywhere, or they sign out every other device
 * from elsewhere. Every request then answers 401, and the page kept showing a
 * stale sidebar and conversation with "Authentication required" above the
 * composer, or nothing at all. Any 401 from the API is reported here; once a
 * session has been confirmed in this tab, the router takes the person to
 * sign-in and says why (router.tsx).
 *
 * A tab that never had a session (a first visit) and a deliberate sign-out
 * get no such notice.
 */

let confirmed = false;
const listeners = new Set<() => void>();

/** The API confirmed a session (GET /api/me answered). */
export function noteSessionConfirmed(): void {
  confirmed = true;
}

/** Signing out on purpose: the requests that follow are refused as expected. */
export function noteSigningOut(): void {
  confirmed = false;
}

/** A request was refused for want of a session (HTTP 401). */
export function noteUnauthorized(): void {
  if (!confirmed) return;
  confirmed = false;
  for (const listener of listeners) listener();
}

export function noteUnauthorizedResponse(response: Response): void {
  if (response.status === 401) noteUnauthorized();
}

/** Called once each time a confirmed session is found to have ended. */
export function onSessionEnded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The sign-in page's query parameter for "you were signed out". */
export const SIGNED_OUT_PARAM = 'signed-out';

/**
 * The page to go back to after signing in (#225).
 *
 * A signed-out visit to a page that needs a session goes to sign-in with the
 * page's address in `?redirect=`, and sign-in returns there: an administrator
 * following a link from an alert or a report email to /admin/webhooks landed
 * on the chat home every time.
 *
 * Only a path on this site is accepted. An absolute URL, a protocol-relative
 * `//host`, a backslash (`/\host`, which browsers read as `//host`), control
 * characters, or anything else that resolves to another origin is refused,
 * so a crafted sign-in link cannot send someone elsewhere afterwards (an open
 * redirect). The sign-in pages themselves and the API are refused too.
 */

/** The sign-in page's query parameter holding the page to return to. */
export const RETURN_PARAM = 'redirect';

export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  // Backslashes and control characters: browsers fold or strip them, turning
  // a path into another host.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The page sign-in should return to, from its own address; null for the home page. */
export function returnPathFromSearch(search = window.location.search): string | null {
  return safeReturnPath(new URLSearchParams(search).get(RETURN_PARAM));
}

/**
 * The sign-in page's search for a visit to `href` that needs a session. The
 * home page needs no parameter: it is where sign-in goes anyway.
 */
export function signInSearch(href: string): Record<string, string> {
  const path = safeReturnPath(href);
  return path && path !== '/' ? { [RETURN_PARAM]: path } : {};
}

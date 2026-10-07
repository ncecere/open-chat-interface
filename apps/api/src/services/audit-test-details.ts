import { SEARCH_PROVIDERS, type SearchProviderKind, type SearchTestResult } from '@oci/shared';
import { redactLogText } from '../lib/log-redaction.js';

/**
 * What a Test button's audit entry records about its outcome (#343). A
 * successful test says where it went; a failed one is the entry people read
 * later, so it says why and where too (as `webhook.test.send` always did with
 * its URL and HTTP status). The reason is the server's own wording, so it is
 * cleaned of anything that could be a credential before it is stored: the
 * audit log is read by auditors and exported as CSV.
 */

const REASON_LIMIT = 300;

/** `name=value` or `name: value` pairs whose name says the value is a secret. */
const SECRET_PAIR =
  /\b((?:x-amz-)?(?:api[-_ ]?key|apikey|access[-_ ]?key(?:[-_ ]?id)?|secret(?:[-_ ]?access)?[-_ ]?key|secret|token|password|passwd|pwd|signature|credential|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+\S+|[^\s&,;"'<>]+)/gi;
/** `Authorization: Bearer abc` and a bare `Bearer abc`. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g;
/** User and password in a URL: `smtp://user:pass@host`. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi;
/** Provider key shapes: `sk-…`, `whsec_…`, AWS access key ids, GitHub-style tokens. */
const KEY_SHAPES =
  /\b(?:sk|pk|rk|whsec|tvly|xai|gsk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
/** A long unbroken run of key-like characters (hex or base64 secrets), not a word or host. */
const LONG_TOKEN = /\b(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}\b/g;

/**
 * The text with credentials removed and cut to one short line: URL user and
 * password, `key=value` pairs whose name says secret, bearer tokens, the
 * shapes API keys have, long token-like strings and the values a failed
 * database query was run with. `known` are values the caller
 * has in hand (a key typed on the page, a stored password): they are removed
 * wherever they appear, even when nothing around them looks secret.
 */
export function redactedReason(text: string, known: (string | null | undefined)[] = []): string {
  let out = redactLogText(text).replace(/\s+/g, ' ').trim();
  for (const secret of known) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(URL_USERINFO, '$1[redacted]@')
    .replace(SECRET_PAIR, '$1[redacted]')
    .replace(AUTH_SCHEME, '$1 [redacted]')
    .replace(KEY_SHAPES, '[redacted]')
    .replace(LONG_TOKEN, '[redacted]');
  return out.length > REASON_LIMIT ? `${out.slice(0, REASON_LIMIT)}…` : out;
}

/**
 * An address as it is safe to record: no user, password, query or fragment
 * (a search provider's key can ride in the query), just where the test went.
 * Text that is not a URL (a host name) is returned trimmed.
 */
export function auditedAddress(address: string | null | undefined): string | null {
  const value = address?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return redactedReason(value);
  }
}

/**
 * What a web search test tried and why it failed, for its audit entry: the
 * address (for providers that are reached at an address you choose) and, on
 * failure, the reason. `prefix` names the fallback provider's keys. `known` are
 * the keys typed on the page or stored, removed from the reason.
 */
export function searchTestAuditDetails(
  target: { provider: SearchProviderKind; baseUrl?: string | null },
  outcome: Omit<SearchTestResult, 'fallback'>,
  known: (string | null | undefined)[],
  prefix?: 'fallback',
): Record<string, unknown> {
  const key = (name: 'BaseUrl' | 'Reason') =>
    prefix ? `${prefix}${name}` : `${name[0]?.toLowerCase()}${name.slice(1)}`;
  const address =
    SEARCH_PROVIDERS[target.provider].needs === 'baseUrl' ? auditedAddress(target.baseUrl) : null;
  return {
    ...(address ? { [key('BaseUrl')]: address } : {}),
    ...(outcome.ok ? {} : { [key('Reason')]: redactedReason(outcome.message ?? '', known) }),
  };
}

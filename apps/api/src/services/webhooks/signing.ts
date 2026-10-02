import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures: HMAC-SHA256 over `<timestamp>.<body>` with the
 * endpoint's secret, sent as `OCI-Webhook-Signature: v1=<hex>` next to
 * `OCI-Webhook-Timestamp: <unix seconds>`. Signing the timestamp lets a
 * receiver reject replays older than a few minutes. See
 * docs/admin/observability.md for a verification example.
 */

export const SIGNATURE_HEADER = 'OCI-Webhook-Signature';
export const TIMESTAMP_HEADER = 'OCI-Webhook-Timestamp';
export const ID_HEADER = 'OCI-Webhook-Id';
export const EVENT_HEADER = 'OCI-Webhook-Event';

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Receiver-side check, also used by the tests: the signature matches and the
 * timestamp is within `toleranceSeconds` of `now`.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  signature: string;
  timestamp: string;
  body: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(input.secret, timestamp, input.body));
  // Several signatures may be sent, comma-separated; any match is enough.
  return input.signature
    .split(',')
    .map((part) => Buffer.from(part.trim()))
    .some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
}

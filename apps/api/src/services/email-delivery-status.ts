import { schema, sql } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getDefaultOrganizationId } from './organization.js';
import { getSetting } from './settings.js';

/**
 * How email delivery has been going, for System health (#327).
 *
 * During an SMTP outage (an expired relay password, the mail server down),
 * nobody could verify an address or reset a password, and System health
 * still said "Sending through <host>": it only checked that a host was
 * configured. Every send now records its outcome here, so the page says
 * when the latest emails failed, and why.
 *
 * Kept in the database, beside the settings but outside the settings cache,
 * because the API replicas and the worker (report emails) all send, and the
 * health page may be served by any of them. One small upsert per email.
 */
const STATUS_KEY = 'emailDeliveryStatus';

export interface EmailDeliveryStatus {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** The mail server's reason, as Send test email shows it. No message content. */
  lastFailureReason: string | null;
  /** Failed sends since the last one that worked. */
  failuresSinceSuccess: number;
}

/** The reason to show an administrator: the transport's message, trimmed. */
export function deliveryFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error';
}

/**
 * Records one send. Never throws: a status that cannot be written must not
 * turn a delivered email into a failure, or a failure into an exception.
 */
export async function recordEmailOutcome(
  outcome: { delivered: true } | { delivered: false; reason: string },
  at = new Date(),
): Promise<void> {
  try {
    const organizationId = await getDefaultOrganizationId();
    const when = at.toISOString();
    const first = outcome.delivered
      ? { lastSuccessAt: when, failuresSinceSuccess: 0 }
      : { lastFailureAt: when, lastFailureReason: outcome.reason, failuresSinceSuccess: 1 };
    const update = outcome.delivered
      ? sql`jsonb_build_object('lastSuccessAt', ${when}::text, 'failuresSinceSuccess', 0)`
      : sql`jsonb_build_object(
          'lastFailureAt', ${when}::text,
          'lastFailureReason', ${outcome.reason}::text,
          'failuresSinceSuccess',
          coalesce((${schema.instanceSetting}.value->>'failuresSinceSuccess')::int, 0) + 1
        )`;
    await db.execute(sql`
      insert into ${schema.instanceSetting} (organization_id, key, value)
      values (${organizationId}, ${STATUS_KEY}, ${JSON.stringify(first)}::jsonb)
      on conflict (organization_id, key) do update
        set value = ${schema.instanceSetting}.value || ${update}, updated_at = now()
    `);
  } catch (error) {
    logger.warn({ err: String(error) }, 'Could not record the email delivery outcome');
  }
}

export async function emailDeliveryStatus(): Promise<EmailDeliveryStatus | null> {
  const organizationId = await getDefaultOrganizationId();
  const rows = await db.execute<{ value: Partial<EmailDeliveryStatus> }>(sql`
    select value from ${schema.instanceSetting}
    where organization_id = ${organizationId} and key = ${STATUS_KEY}
    limit 1
  `);
  const value = [...rows][0]?.value;
  if (!value) return null;
  return {
    lastSuccessAt: value.lastSuccessAt ?? null,
    lastFailureAt: value.lastFailureAt ?? null,
    lastFailureReason: value.lastFailureReason ?? null,
    failuresSinceSuccess: Number(value.failuresSinceSuccess ?? 0),
  };
}

/** "2026-10-06 14:31 UTC", as the other health rows write times. */
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

/**
 * System health's Email delivery row: not configured, failing (the latest
 * send failed, with when and why), or sending. A warning rather than an
 * error, as for connectors: the rest of the service keeps working.
 */
export async function emailHealthCheck(): Promise<Check> {
  const base = { id: 'email', label: 'Email delivery' } as const;
  const smtp = await getSetting('smtp');
  if (!smtp.host || !smtp.port || !smtp.fromAddress)
    return {
      ...base,
      status: 'warn',
      detail: 'Not configured. Invitations and password resets cannot be sent.',
    };

  const status = await emailDeliveryStatus();
  const failing =
    status?.lastFailureAt && (!status.lastSuccessAt || status.lastFailureAt > status.lastSuccessAt);
  if (status && failing) {
    const count = Math.max(1, status.failuresSinceSuccess);
    const which = count === 1 ? 'The latest email' : `The latest ${count} emails`;
    return {
      ...base,
      status: 'warn',
      detail: `${which} through ${smtp.host} failed, most recently at ${utc(status.lastFailureAt!)}: ${
        status.lastFailureReason ?? 'unknown error'
      }. Until email works, people cannot verify their address or reset their password. Check it with Send test email under Email delivery.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    detail: status?.lastSuccessAt
      ? `Sending through ${smtp.host}; last delivered ${utc(status.lastSuccessAt)}`
      : `Sending through ${smtp.host}`,
  };
}

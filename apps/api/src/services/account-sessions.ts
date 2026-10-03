import { and, desc, eq, gt, ne, schema } from '@oci/db';
import type { AccountSession } from '@oci/shared';
import { db } from '../db/index.js';
import { notFound, validationFailed } from '../lib/errors.js';

/**
 * Settings → Account → Devices (v0.9.1): the places a person is signed in,
 * and signing them out.
 *
 * Kept apart from Better Auth's list-sessions endpoint for three reasons: that
 * one sends every session's token to the browser, refuses a session older
 * than a day ("not fresh"), and shows full IP addresses. Here a session is
 * named by its id, any signed-in session may look, and addresses are
 * shortened. Revoking deletes the row, as an administrator's "Sign out
 * everywhere" does; a device's cached session cookie can keep it signed in
 * for up to five minutes afterwards.
 */

/** "203.0.113.42" → "203.0.113.x"; IPv6 keeps its first three groups. */
export function maskIpAddress(value: string | null): string | null {
  const ip = value?.trim();
  if (!ip) return null;
  const mapped = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
  const v4 = mapped.split('.');
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part))) {
    return `${v4.slice(0, 3).join('.')}.x`;
  }
  if (mapped.includes(':')) {
    const groups = mapped.split(':').filter(Boolean).slice(0, 3);
    return groups.length > 0 ? `${groups.join(':')}:…` : null;
  }
  return null;
}

export async function listOwnSessions(
  userId: string,
  currentSessionId: string | null,
): Promise<AccountSession[]> {
  const rows = await db
    .select()
    .from(schema.session)
    .where(and(eq(schema.session.userId, userId), gt(schema.session.expiresAt, new Date())))
    .orderBy(desc(schema.session.updatedAt), desc(schema.session.id));
  const sessions = rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    userAgent: row.userAgent?.slice(0, 500) ?? null,
    ipAddress: maskIpAddress(row.ipAddress),
    impersonated: Boolean(row.impersonatedBy),
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
  }));
  // This device first, then most recently active.
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)];
}

/** Signs one other device out. The current session signs out with "Sign out". */
export async function revokeOwnSession(
  userId: string,
  sessionId: string,
  currentSessionId: string | null,
): Promise<void> {
  if (sessionId === currentSessionId) {
    throw validationFailed('Use Sign out to end the session on this device');
  }
  const deleted = await db
    .delete(schema.session)
    .where(and(eq(schema.session.id, sessionId), eq(schema.session.userId, userId)))
    .returning({ id: schema.session.id });
  if (deleted.length === 0) throw notFound('Session not found');
}

/** Signs out every device but this one; returns how many were signed out. */
export async function revokeOtherOwnSessions(
  userId: string,
  currentSessionId: string | null,
): Promise<number> {
  // Without a known current session this would sign the person out too.
  if (!currentSessionId) throw validationFailed('The current session could not be identified');
  const deleted = await db
    .delete(schema.session)
    .where(and(eq(schema.session.userId, userId), ne(schema.session.id, currentSessionId)))
    .returning({ id: schema.session.id });
  return deleted.length;
}

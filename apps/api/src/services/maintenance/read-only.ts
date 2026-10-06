import { and, eq, schema } from '@oci/db';
import {
  DEFAULT_READ_ONLY_KEEP_RUNNING_JOBS,
  type MaintenanceSettings,
  type ReadOnlyStatus,
  type UpdateMaintenanceInput,
} from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { getDisplayTimezone } from '../lifecycle/settings.js';
import { registerCollectedGauge } from '../observability/metrics.js';
import { getDefaultOrganizationId } from '../organization.js';
import {
  getSetting,
  invalidateSettingsCache,
  type StoredMaintenanceSettings,
  updateSetting,
} from '../settings.js';

/**
 * Read-only maintenance mode (v0.11 design, section 9;
 * docs/admin/maintenance.md).
 *
 * On when any of these holds, in this order of precedence:
 *
 * 1. `OCI_READ_ONLY=true` in the environment (emergencies; cannot be turned
 *    off from administration);
 * 2. an administrator's switch (the `maintenance` setting), until turned off;
 * 3. a scheduled window, from its start until its end.
 *
 * The setting is read through the settings cache, which every replica clears
 * when it changes (services/cache-bus), so a switch applies on all replicas
 * at once; a window is a time, evaluated by each replica on its own clock.
 * Writes are refused by middleware/read-only.ts; background jobs that write
 * pause (`jobPausedByReadOnly`).
 */

interface Window {
  startsAt: number;
  endsAt: number;
  reason: string | null;
  announcementId: string | null;
}

function parseWindow(stored: StoredMaintenanceSettings['window']): Window | null {
  if (!stored) return null;
  const startsAt = Date.parse(stored.startsAt);
  const endsAt = Date.parse(stored.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return null;
  return {
    startsAt,
    endsAt,
    reason: stored.reason ?? null,
    announcementId: stored.announcementId ?? null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The jobs that keep running while read-only: the administrator's list, else the defaults. */
export function keepRunningJobs(stored: StoredMaintenanceSettings): string[] {
  return stored.keepRunningJobs ?? [...DEFAULT_READ_ONLY_KEEP_RUNNING_JOBS];
}

/** Whether writes are refused now, and why, from the stored setting and the environment. */
export function evaluateReadOnly(
  stored: StoredMaintenanceSettings,
  env: { OCI_READ_ONLY?: boolean; OCI_READ_ONLY_REASON?: string },
  now = Date.now(),
): ReadOnlyStatus {
  const window = parseWindow(stored.window);
  // A window that has ended is history: not shown, not applied.
  const shownWindow =
    window && window.endsAt > now
      ? { startsAt: iso(window.startsAt), endsAt: iso(window.endsAt) }
      : null;
  if (env.OCI_READ_ONLY) {
    return {
      active: true,
      source: 'environment',
      reason: env.OCI_READ_ONLY_REASON?.trim() || stored.reason || null,
      until: null,
      window: shownWindow,
    };
  }
  if (stored.readOnly) {
    const until = stored.until ? Date.parse(stored.until) : Number.NaN;
    return {
      active: true,
      source: 'administrator',
      reason: stored.reason ?? null,
      // An expected end already passed says nothing about when it will end.
      until: Number.isFinite(until) && until > now ? iso(until) : null,
      window: shownWindow,
    };
  }
  if (window && window.startsAt <= now && now < window.endsAt) {
    return {
      active: true,
      source: 'schedule',
      reason: window.reason ?? stored.reason ?? null,
      until: iso(window.endsAt),
      window: shownWindow,
    };
  }
  return { active: false, source: null, reason: null, until: null, window: shownWindow };
}

/** The status now, through the settings cache (cleared on every replica when it changes). */
export async function readOnlyStatus(now = Date.now()): Promise<ReadOnlyStatus> {
  return evaluateReadOnly(await getSetting('maintenance'), loadEnv(), now);
}

/**
 * Whether the job runner should leave `job` alone now: read-only, and not one
 * of the jobs chosen to keep running. A job already running stops at its next
 * check between batches (jobMayContinue). Never throws: if the setting cannot
 * be read, jobs run (they would fail on the database anyway).
 */
export async function jobPausedByReadOnly(job: string): Promise<boolean> {
  try {
    const stored = await getSetting('maintenance');
    if (!evaluateReadOnly(stored, loadEnv()).active) return false;
    return !keepRunningJobs(stored).includes(job);
  } catch (error) {
    logger.debug({ err: String(error), job }, 'Could not read the read-only setting for a job');
    return false;
  }
}

/** Seconds a client should wait before trying a write again, when the end is known. */
export function retryAfterSeconds(status: ReadOnlyStatus, now = Date.now()): number | null {
  if (!status.active || !status.until) return null;
  const ms = Date.parse(status.until) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : null;
}

registerCollectedGauge(
  'oci_read_only',
  'Whether this replica refuses writes for read-only maintenance mode (1) or not (0).',
  [],
  async () => [{ value: (await readOnlyStatus().catch(() => null))?.active ? 1 : 0 }],
);

/** The administrator's view, with each known job and whether it keeps running. */
export async function maintenanceView(jobNames: readonly string[]): Promise<MaintenanceSettings> {
  const stored = await getSetting('maintenance');
  const env = loadEnv();
  const keep = new Set(keepRunningJobs(stored));
  const defaults = new Set<string>(DEFAULT_READ_ONLY_KEEP_RUNNING_JOBS);
  const window = parseWindow(stored.window);
  return {
    status: evaluateReadOnly(stored, env),
    environmentLocked: env.OCI_READ_ONLY,
    readOnly: stored.readOnly === true,
    reason: stored.reason ?? null,
    until: stored.until ?? null,
    changedAt: stored.changedAt ?? null,
    changedBy: stored.changedBy ?? null,
    window:
      window && window.endsAt > Date.now()
        ? {
            startsAt: iso(window.startsAt),
            endsAt: iso(window.endsAt),
            reason: window.reason,
            announcementId: window.announcementId,
          }
        : null,
    jobs: [...jobNames].sort().map((name) => ({
      name,
      keepsRunning: keep.has(name),
      defaultKeepsRunning: defaults.has(name),
    })),
  };
}

function formatWhen(ms: number, timeZone: string): string {
  // dateStyle and timeStyle cannot be combined with timeZoneName.
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(ms));
}

/**
 * The announcement of a scheduled window (an ordinary broadcast, so people see
 * it as any other): shown from now until the window starts, when the
 * read-only banner takes over. Updating the window updates it and shows it
 * again to people who had hidden it.
 */
async function announceWindow(
  window: { startsAt: number; endsAt: number; reason: string | null },
  existingId: string | null,
  actorId: string,
): Promise<string | null> {
  const organizationId = await getDefaultOrganizationId();
  const timeZone = await getDisplayTimezone();
  const values = {
    title: 'Scheduled maintenance',
    body:
      `From ${formatWhen(window.startsAt, timeZone)} until ${formatWhen(window.endsAt, timeZone)}, ` +
      'this service will be read-only: you can read, search and export conversations, but not ' +
      'send messages, upload files or change settings.' +
      (window.reason ? ` ${window.reason}` : ''),
    level: 'warning' as const,
    audienceRoles: [],
    dismissable: true,
    published: true,
    startsAt: null,
    endsAt: new Date(window.startsAt),
  };
  if (existingId) {
    const [updated] = await db
      .update(schema.broadcast)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.id, existingId),
          eq(schema.broadcast.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.broadcast.id });
    if (updated) {
      await db
        .delete(schema.broadcastDismissal)
        .where(eq(schema.broadcastDismissal.broadcastId, existingId));
      return updated.id;
    }
  }
  const [created] = await db
    .insert(schema.broadcast)
    .values({ ...values, organizationId, createdByUserId: actorId })
    .returning({ id: schema.broadcast.id });
  return created?.id ?? null;
}

async function removeAnnouncement(id: string | null): Promise<void> {
  if (!id) return;
  await db.delete(schema.broadcast).where(eq(schema.broadcast.id, id));
}

/**
 * Applies an administrator's change (System health, Maintenance), records who
 * made it, when and why, and announces a scheduled window. Every replica
 * applies it at once (the settings change is published). `knownJobs` checks
 * the jobs chosen to keep running.
 */
export async function updateMaintenance(
  input: UpdateMaintenanceInput,
  actor: { id: string; email: string },
  knownJobs: readonly string[],
): Promise<MaintenanceSettings> {
  if (input.keepRunningJobs) {
    const unknown = input.keepRunningJobs.filter((name) => !knownJobs.includes(name));
    if (unknown.length > 0) throw validationFailed(`Unknown background job: ${unknown.join(', ')}`);
  }
  // Decide from the database, not a copy cached before another replica's change.
  invalidateSettingsCache('maintenance');
  const current = await getSetting('maintenance');
  const env = loadEnv();
  const before = evaluateReadOnly(current, env);
  const next: StoredMaintenanceSettings = { ...current };

  if (input.readOnly !== undefined && input.readOnly !== (current.readOnly === true)) {
    next.readOnly = input.readOnly;
    next.changedAt = new Date().toISOString();
    next.changedBy = actor.email;
    // Turning it off ends the stated expectation and its reason with it: a
    // reason kept from an earlier window prefilled the next one and stood in
    // for a scheduled window's missing reason (#222).
    if (!input.readOnly && input.until === undefined) next.until = null;
    if (!input.readOnly && input.reason === undefined) next.reason = null;
  }
  if (input.reason !== undefined) next.reason = input.reason || null;
  if (input.until !== undefined) next.until = input.until;
  if (input.keepRunningJobs !== undefined)
    next.keepRunningJobs = [...new Set(input.keepRunningJobs)];

  if (input.window !== undefined) {
    const previous = parseWindow(current.window);
    if (input.window === null) {
      await removeAnnouncement(previous?.announcementId ?? null);
      next.window = null;
    } else {
      const startsAt = Date.parse(input.window.startsAt);
      const endsAt = Date.parse(input.window.endsAt);
      const reason = input.window.reason ?? null;
      let announcementId = previous?.announcementId ?? null;
      if (input.window.announce && startsAt > Date.now()) {
        announcementId = await announceWindow(
          { startsAt, endsAt, reason },
          announcementId,
          actor.id,
        );
      } else {
        await removeAnnouncement(announcementId);
        announcementId = null;
      }
      next.window = {
        startsAt: iso(startsAt),
        endsAt: iso(endsAt),
        reason,
        announcementId,
      };
    }
  }

  await updateSetting('maintenance', next);
  const after = evaluateReadOnly(next, env);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'maintenance.read_only.update',
    targetType: 'instance_setting',
    targetId: 'maintenance',
    metadata: {
      // Who and when are the entry itself; why is the reason.
      changes: { ...input },
      active: { before: before.active, after: after.active },
      source: after.source,
      reason: after.reason ?? next.reason ?? null,
      // The expected end as saved. The status's own `until` is null for an
      // end already past, which recorded a saved end as none (#221).
      until: after.source === 'schedule' ? after.until : (next.until ?? null),
      previous: {
        readOnly: current.readOnly === true,
        reason: current.reason ?? null,
        until: current.until ?? null,
      },
      window: next.window ? { startsAt: next.window.startsAt, endsAt: next.window.endsAt } : null,
      keepRunningJobs: keepRunningJobs(next),
    },
  });
  if (before.active !== after.active)
    logger.warn(
      { actor: actor.email, source: after.source, reason: after.reason },
      after.active
        ? 'Read-only maintenance mode switched on'
        : 'Read-only maintenance mode switched off',
    );
  return maintenanceView(knownJobs);
}

/**
 * System health's row: a warning while writes are refused, saying why and
 * until when. Times stay ISO 8601 instants here (the server does not know the
 * reader's time zone); the System health page shows each in the reader's
 * local time, as the Maintenance card does (#259).
 */
export async function readOnlyHealthCheck(): Promise<{
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}> {
  const status = await readOnlyStatus();
  const base = { id: 'read-only', label: 'Read-only mode' };
  if (!status.active) {
    return {
      ...base,
      status: 'ok',
      detail: status.window
        ? `Off. Scheduled from ${status.window.startsAt} until ${status.window.endsAt}.`
        : 'Off: people can make changes.',
    };
  }
  // Worded as the Maintenance card words it ("Read-only, by an administrator").
  const by =
    status.source === 'environment'
      ? 'because OCI_READ_ONLY is set in the environment (unset it on every replica to end it)'
      : status.source === 'schedule'
        ? 'for a scheduled window'
        : 'by an administrator';
  return {
    ...base,
    status: 'warn',
    detail: `On, ${by}${status.until ? `, until about ${status.until}` : ''}: changes are refused.${
      status.reason ? ` Reason: ${status.reason}` : ''
    }`,
  };
}

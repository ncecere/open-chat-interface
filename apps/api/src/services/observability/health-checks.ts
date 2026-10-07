import { count, desc, eq, isNull, schema } from '@oci/db';
import type { ObservabilityStatus } from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { backupSettings } from '../backups/settings.js';
import { complianceSettings } from '../compliance/settings.js';
import { webhookQueueStats } from '../webhooks/delivery.js';
import { tracingEnabled, tracingEndpointOrigin } from './tracing.js';

/** System health rows for backups and webhooks, and the read-only observability status. */

interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

const DAY_MS = 24 * 60 * 60_000;

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return 'unknown size';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Off is fine (many deployments back up their own way). When on: the latest
 * run failed is an error; no verified backup in over a day, or attachment
 * objects missing from the last one, is a warning.
 */
export async function backupHealthCheck(now = new Date()): Promise<Check> {
  const base = { id: 'backups', label: 'Backups' } as const;
  const settings = await backupSettings();
  const [latest] = await db
    .select()
    .from(schema.backupRun)
    .orderBy(desc(schema.backupRun.startedAt))
    .limit(1);
  // Off is a deliberate choice and old runs are history, but a backup that
  // was just tried and failed (a manual run, a destination test gone wrong)
  // is not "ok": it said so while the run's history showed the failure.
  if (!settings.enabled) {
    const recentFailure =
      latest?.status === 'failed' && now.getTime() - latest.startedAt.getTime() < 7 * DAY_MS;
    return recentFailure
      ? {
          ...base,
          status: 'warn',
          detail: `Off, and the latest backup (${latest.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC) failed${latest.errorMessage ? `: ${latest.errorMessage.slice(0, 200)}` : ''}`,
        }
      : {
          ...base,
          status: 'ok',
          detail: 'Off. Turn on under Backups unless this instance is backed up another way.',
        };
  }
  const [success] = await db
    .select()
    .from(schema.backupRun)
    .where(eq(schema.backupRun.status, 'succeeded'))
    .orderBy(desc(schema.backupRun.startedAt))
    .limit(1);

  if (latest?.status === 'failed')
    return {
      ...base,
      status: 'error',
      detail: `The latest backup failed${latest.errorMessage ? `: ${latest.errorMessage.slice(0, 200)}` : ''}`,
    };

  if (!success)
    return latest?.status === 'running'
      ? { ...base, status: 'ok', detail: 'The first backup is running.' }
      : { ...base, status: 'warn', detail: 'On, but no backup has completed yet.' };

  const finished = success.finishedAt ?? success.startedAt;
  const verified = success.verified ? 'verified' : 'not verified';
  const summary = `Last backup ${finished.toISOString().slice(0, 16).replace('T', ' ')} UTC, ${verified}, ${sizeLabel(success.dumpBytes)} database, ${success.attachmentCount ?? 0} attachment objects`;
  if (now.getTime() - finished.getTime() > DAY_MS + 2 * 60 * 60_000)
    return { ...base, status: 'warn', detail: `No backup in over a day. ${summary}` };
  if ((success.missingObjects ?? 0) > 0)
    return {
      ...base,
      status: 'warn',
      detail: `${summary}; ${success.missingObjects} attachment object${success.missingObjects === 1 ? '' : 's'} could not be read`,
    };
  return { ...base, status: 'ok', detail: summary };
}

/**
 * Compliance export and legal holds. Off is fine. When on: the latest run
 * failed is an error; no successful export within two schedule periods (plus
 * a margin) is a warning. The number of people on hold is always shown.
 */
export async function complianceHealthCheck(now = new Date()): Promise<Check> {
  const base = { id: 'compliance', label: 'Compliance export' } as const;
  const settings = await complianceSettings();
  const [holds] = await db
    .select({ value: count() })
    .from(schema.legalHold)
    .where(isNull(schema.legalHold.liftedAt));
  const held = holds?.value ?? 0;
  const holdNote = held > 0 ? ` ${held} ${held === 1 ? 'person' : 'people'} on legal hold.` : '';
  if (!settings.enabled) return { ...base, status: 'ok', detail: `Off.${holdNote}` };

  const [latest] = await db
    .select()
    .from(schema.complianceExportRun)
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(1);
  const [success] = await db
    .select()
    .from(schema.complianceExportRun)
    .where(eq(schema.complianceExportRun.status, 'succeeded'))
    .orderBy(desc(schema.complianceExportRun.startedAt))
    .limit(1);
  if (latest?.status === 'failed')
    return {
      ...base,
      status: 'error',
      detail: `The latest export failed${latest.errorMessage ? `: ${latest.errorMessage.slice(0, 200)}` : ''}.${holdNote}`,
    };
  if (!success)
    return latest?.status === 'running'
      ? { ...base, status: 'ok', detail: `The first export is running.${holdNote}` }
      : { ...base, status: 'warn', detail: `On, but no export has completed yet.${holdNote}` };

  const finished = success.finishedAt ?? success.startedAt;
  const period = settings.schedule === 'hourly' ? 60 * 60_000 : DAY_MS;
  const summary = `Last export ${finished.toISOString().slice(0, 16).replace('T', ' ')} UTC (${settings.schedule}${settings.includeContent ? ', with conversation content' : ', audit events only'}).${holdNote}`;
  if (now.getTime() - finished.getTime() > 2 * period + 30 * 60_000)
    return { ...base, status: 'warn', detail: `No export for over two periods. ${summary}` };
  return { ...base, status: 'ok', detail: summary };
}

/** Enabled endpoints whose latest attempt failed, and deliveries stuck past their time. */
export async function webhookHealthCheck(now = new Date()): Promise<Check> {
  const base = { id: 'webhooks', label: 'Webhooks' } as const;
  const endpoints = await db
    .select({
      url: schema.webhookEndpoint.url,
      lastSuccessAt: schema.webhookEndpoint.lastSuccessAt,
      lastFailureAt: schema.webhookEndpoint.lastFailureAt,
      lastError: schema.webhookEndpoint.lastError,
    })
    .from(schema.webhookEndpoint)
    .where(eq(schema.webhookEndpoint.enabled, true));
  if (endpoints.length === 0) return { ...base, status: 'ok', detail: 'None enabled' };

  const failing = endpoints.filter(
    (endpoint) =>
      endpoint.lastFailureAt &&
      (!endpoint.lastSuccessAt || endpoint.lastFailureAt > endpoint.lastSuccessAt),
  );
  const queue = await webhookQueueStats(now);
  if (failing.length > 0) {
    const [first] = failing;
    return {
      ...base,
      status: 'warn',
      detail: `${failing.length} of ${endpoints.length} failing. ${new URL(first!.url).host}: ${first!.lastError ?? 'error'} · ${queue.pending} pending`,
    };
  }
  if (queue.overdue > 0)
    return {
      ...base,
      status: 'warn',
      detail: `${queue.overdue} deliveries are more than 15 minutes overdue. Check that background jobs are running.`,
    };
  return {
    ...base,
    status: 'ok',
    detail: `${endpoints.length} enabled; ${queue.pending} pending`,
  };
}

export function observabilityStatus(): ObservabilityStatus {
  return {
    metrics: Boolean(loadEnv().METRICS_TOKEN),
    tracing: tracingEnabled(),
    tracingEndpoint: tracingEnabled() ? tracingEndpointOrigin() : null,
  };
}

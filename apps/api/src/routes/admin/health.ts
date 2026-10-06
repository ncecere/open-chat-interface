import { and, count, desc, eq, gte, isNull, lt, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { redisHealthCheck } from '../../lib/redis-requirement.js';
import { processRole } from '../../lib/role.js';
import type { AppBindings } from '../../middleware/context.js';
import { UNSENT_UPLOAD_TTL_MS } from '../../services/attachments/index.js';
import { cacheBusHealthCheck } from '../../services/cache-bus/index.js';
import { emailHealthCheck } from '../../services/email-delivery-status.js';
import { embeddingsHealthCheck } from '../../services/embeddings/status.js';
import { encryptionHealthCheck } from '../../services/encryption/rotation.js';
import { liveReplicas, workersHealthCheck } from '../../services/jobs/workers.js';
import { capacityHealthCheck } from '../../services/limits/capacity/overview.js';
import { readOnlyHealthCheck } from '../../services/maintenance/read-only.js';
import {
  backupHealthCheck,
  complianceHealthCheck,
  observabilityStatus,
  webhookHealthCheck,
} from '../../services/observability/health-checks.js';
import { getSetting } from '../../services/settings.js';

export const healthRoutes = new Hono<AppBindings>();

type Status = 'ok' | 'warn' | 'error';

interface Check {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

async function databaseCheck(): Promise<Check> {
  try {
    const started = Date.now();
    await db.execute(sql`select 1`);
    const ms = Date.now() - started;
    return {
      id: 'database',
      label: 'Database',
      status: ms > 500 ? 'warn' : 'ok',
      detail: `Responded in ${ms} ms`,
    };
  } catch (error) {
    logger.error({ error }, 'Admin health: database check failed');
    return { id: 'database', label: 'Database', status: 'error', detail: 'Not reachable' };
  }
}

/**
 * Redis: optional for one replica, required for more (v0.11 design, item 16;
 * lib/redis-requirement.ts). An error when several replicas share the
 * database without it, or when it is configured but unreachable.
 */
function redisCheck(): Promise<Check> {
  return redisHealthCheck();
}

async function providerCheck(): Promise<Check> {
  const [row] = await db
    .select({ total: count() })
    .from(schema.provider)
    .where(eq(schema.provider.enabled, true));

  const enabled = row?.total ?? 0;
  return {
    id: 'providers',
    label: 'Model providers',
    status: enabled > 0 ? 'ok' : 'error',
    detail: enabled > 0 ? `${enabled} enabled` : 'None enabled. Nobody can send a message.',
  };
}

async function modelCheck(): Promise<Check> {
  const [row] = await db
    .select({ total: count() })
    .from(schema.model)
    .where(eq(schema.model.enabled, true));

  const enabled = row?.total ?? 0;
  return {
    id: 'models',
    label: 'Models',
    status: enabled > 0 ? 'ok' : 'error',
    detail: enabled > 0 ? `${enabled} available` : 'None enabled. Nobody can send a message.',
  };
}

/** A job left running long past any plausible duration has died mid-flight. */
const STUCK_AFTER_MS = 60 * 60 * 1000;

async function jobCheck(): Promise<Check> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [failures, stuck] = await Promise.all([
    db
      .select({ total: count() })
      .from(schema.jobRun)
      .where(and(eq(schema.jobRun.status, 'error'), gte(schema.jobRun.startedAt, dayAgo))),
    db
      .select({ total: count() })
      .from(schema.jobRun)
      .where(
        and(
          eq(schema.jobRun.status, 'running'),
          isNull(schema.jobRun.finishedAt),
          lt(schema.jobRun.startedAt, new Date(Date.now() - STUCK_AFTER_MS)),
        ),
      ),
  ]);

  const failed = failures[0]?.total ?? 0;
  const hanging = stuck[0]?.total ?? 0;

  if (hanging > 0) {
    return {
      id: 'jobs',
      label: 'Background jobs',
      status: 'error',
      detail: `${hanging} started over an hour ago and never finished`,
    };
  }
  if (failed > 0) {
    return {
      id: 'jobs',
      label: 'Background jobs',
      status: 'warn',
      detail: `${failed} failed in the last 24 hours`,
    };
  }
  return { id: 'jobs', label: 'Background jobs', status: 'ok', detail: 'No recent failures' };
}

async function storageCheck(): Promise<Check> {
  const storage = await getSetting('storage');

  const [orphans] = await db
    .select({ total: count() })
    .from(schema.attachment)
    // Never attached to a message and older than the hourly cleanup allows
    // (#297): an abandoned upload it has not removed, still occupying storage.
    // Younger ones are ordinary drafts. Project files belong to their project
    // instead of a message and are not stale.
    .where(
      and(
        isNull(schema.attachment.messageId),
        isNull(schema.attachment.projectId),
        isNull(schema.attachment.deletedAt),
        lt(
          schema.attachment.createdAt,
          new Date(Date.now() - UNSENT_UPLOAD_TTL_MS - 2 * 60 * 60 * 1000),
        ),
      ),
    );

  const stale = orphans?.total ?? 0;
  return {
    id: 'storage',
    label: 'Attachment storage',
    status: stale > 0 ? 'warn' : 'ok',
    detail:
      stale > 0
        ? `${storage.driver}: ${stale} upload${stale === 1 ? '' : 's'} never attached to a message`
        : `${storage.driver}: no stale uploads`,
  };
}

/**
 * Enabled connectors whose latest exchange failed: their last failure is newer
 * than their last success. A warning, since the rest of OCI keeps working.
 */
async function connectorCheck(): Promise<Check> {
  const rows = await db
    .select({
      name: schema.connector.name,
      lastContactAt: schema.connector.lastContactAt,
      lastErrorAt: schema.connector.lastErrorAt,
      lastError: schema.connector.lastError,
    })
    .from(schema.connector)
    .where(eq(schema.connector.enabled, true))
    .orderBy(schema.connector.name);
  if (rows.length === 0)
    return { id: 'connectors', label: 'Connectors', status: 'ok', detail: 'None enabled' };
  const failing = rows.filter(
    (row) =>
      row.lastErrorAt &&
      (!row.lastContactAt || row.lastErrorAt.getTime() > row.lastContactAt.getTime()),
  );
  if (failing.length === 0)
    return {
      id: 'connectors',
      label: 'Connectors',
      status: 'ok',
      detail: `${rows.length} enabled; no failures since their last successful contact`,
    };
  const [first] = failing;
  return {
    id: 'connectors',
    label: 'Connectors',
    status: 'warn',
    detail: `${failing.length} of ${rows.length} failing. ${first!.name}: ${first!.lastError ?? 'error'}${
      failing.length > 1 ? ` (and ${failing.length - 1} more)` : ''
    }`,
  };
}

/** pgvector and meaning-based search for project files (v0.9). */
async function embeddingsCheck(): Promise<Check> {
  try {
    return await embeddingsHealthCheck();
  } catch (error) {
    logger.error({ error }, 'Admin health: embeddings check failed');
    return {
      id: 'embeddings',
      label: 'Meaning-based search',
      status: 'warn',
      detail: 'Could not be checked',
    };
  }
}

/** Backups and webhooks (v0.9): a check that throws becomes a warning, not a failed page. */
async function guarded(id: string, label: string, check: () => Promise<Check>): Promise<Check> {
  try {
    return await check();
  } catch (error) {
    logger.error({ error, check: id }, 'Admin health: check failed');
    return { id, label, status: 'warn', detail: 'Could not be checked' };
  }
}

/**
 * Operational state in one place.
 *
 * Each of these previously surfaced as a user complaint: nobody can send a
 * message because every provider is disabled, invitations vanish because SMTP
 * was never configured, retention silently stopped because its job has been
 * failing for a week.
 */
healthRoutes.get('/', async (c) => {
  const checks = await Promise.all([
    databaseCheck(),
    redisCheck(),
    providerCheck(),
    modelCheck(),
    jobCheck(),
    // Not configured, failing (the latest send failed, #327), or sending.
    guarded('email', 'Email delivery', emailHealthCheck),
    storageCheck(),
    connectorCheck(),
    embeddingsCheck(),
    guarded('backups', 'Backups', backupHealthCheck),
    guarded('webhooks', 'Webhooks', webhookHealthCheck),
    guarded('compliance', 'Compliance export', complianceHealthCheck),
    // v0.11: a deployment of OCI_ROLE=web replicas only runs no background jobs.
    guarded('workers', 'Background workers', workersHealthCheck),
    // v0.11: turns waiting for, and providers throttling, model capacity.
    guarded('capacity', 'Provider capacity', capacityHealthCheck),
    // v0.11: read-only maintenance mode and cross-replica cache invalidation.
    guarded('read-only', 'Read-only mode', readOnlyHealthCheck),
    guarded('cache-invalidation', 'Cache invalidation', cacheBusHealthCheck),
    // v0.11: values still needing a previous ENCRYPTION_KEY, before it can be retired.
    guarded('encryption', 'Encryption keys', () => encryptionHealthCheck()),
  ]);
  const replicas = await liveReplicas().catch(() => null);

  const recentJobs = await db
    .select({
      id: schema.jobRun.id,
      jobName: schema.jobRun.jobName,
      status: schema.jobRun.status,
      startedAt: schema.jobRun.startedAt,
      durationMs: schema.jobRun.durationMs,
      itemsProcessed: schema.jobRun.itemsProcessed,
      errorMessage: schema.jobRun.errorMessage,
    })
    .from(schema.jobRun)
    .orderBy(desc(schema.jobRun.startedAt))
    .limit(10);

  // The worst individual result decides the overall one: a green summary above
  // a failing row would be worse than no summary at all.
  const status: Status = checks.some((check) => check.status === 'error')
    ? 'error'
    : checks.some((check) => check.status === 'warn')
      ? 'warn'
      : 'ok';

  return c.json({
    status,
    checks,
    // Configured by environment only; shown read-only.
    observability: observabilityStatus(),
    // Replicas heard from in the last minute (null without Redis), v0.11.
    // Without each worker's job list: the Background jobs section shows those (#256).
    replicas: {
      role: processRole(),
      live: replicas?.map(({ jobs: _jobs, ...rest }) => rest) ?? null,
    },
    recentJobs: recentJobs.map((job) => ({
      ...job,
      startedAt: job.startedAt.toISOString(),
    })),
  });
});

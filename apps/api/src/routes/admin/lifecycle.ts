import { and, eq, schema } from '@oci/db';
import {
  updateRateLimitSettingsSchema,
  updateRetentionSettingsSchema,
  upsertStoragePolicySchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { recentJobRuns, runJobNow } from '../../services/jobs/index.js';
import {
  getRateLimitSettings,
  getRetentionSettings,
  updateRateLimitSettings,
  updateRetentionSettings,
} from '../../services/lifecycle/settings.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { listStoragePolicies, storageTotals } from '../../services/storage/quota.js';
import { pendingDeletionCount, reconcileStorage } from '../../services/storage/reaper.js';

export const lifecycleRoutes = new Hono<AppBindings>();

lifecycleRoutes.get('/storage-policies', async (c) => {
  return c.json({ policies: await listStoragePolicies() });
});

lifecycleRoutes.put('/storage-policies/:role', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertStoragePolicySchema);
  const organizationId = await getDefaultOrganizationId();

  await db
    .insert(schema.storagePolicy)
    .values({
      organizationId,
      role: input.role,
      maxTotalBytes: input.maxTotalBytes ?? null,
      maxFileCount: input.maxFileCount ?? null,
      maxFileBytes: input.maxFileBytes ?? null,
      enabled: input.enabled,
    })
    .onConflictDoUpdate({
      target: [schema.storagePolicy.organizationId, schema.storagePolicy.role],
      set: {
        maxTotalBytes: input.maxTotalBytes ?? null,
        maxFileCount: input.maxFileCount ?? null,
        maxFileBytes: input.maxFileBytes ?? null,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.policy.update',
    targetType: 'storage_policy',
    targetId: input.role,
    metadata: {
      maxTotalBytes: input.maxTotalBytes ?? null,
      maxFileCount: input.maxFileCount ?? null,
      maxFileBytes: input.maxFileBytes ?? null,
      enabled: input.enabled,
    },
  });

  return c.json({ ok: true });
});

lifecycleRoutes.delete('/storage-policies/:role', async (c) => {
  const actor = currentUser(c);
  const role = c.req.param('role');
  const organizationId = await getDefaultOrganizationId();

  const removed = await db
    .delete(schema.storagePolicy)
    .where(
      and(
        eq(schema.storagePolicy.organizationId, organizationId),
        eq(schema.storagePolicy.role, role as never),
      ),
    )
    .returning({ id: schema.storagePolicy.id });

  if (removed.length === 0) throw notFound('Storage policy not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.policy.delete',
    targetType: 'storage_policy',
    targetId: role,
  });

  return c.json({ ok: true });
});

lifecycleRoutes.get('/retention', async (c) => {
  return c.json(await getRetentionSettings());
});

lifecycleRoutes.put('/retention', async (c) => {
  const actor = currentUser(c);
  const patch = await parseBody(c, updateRetentionSettingsSchema);
  const settings = await updateRetentionSettings(patch);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'retention.settings.update',
    targetType: 'settings',
    targetId: 'retention',
    metadata: patch,
  });

  return c.json(settings);
});

lifecycleRoutes.get('/rate-limits', async (c) => {
  return c.json(await getRateLimitSettings());
});

lifecycleRoutes.put('/rate-limits', async (c) => {
  const actor = currentUser(c);
  const patch = await parseBody(c, updateRateLimitSettingsSchema);
  const settings = await updateRateLimitSettings(patch);

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'rate_limit.settings.update',
    targetType: 'settings',
    targetId: 'rateLimits',
    metadata: patch,
  });

  return c.json(settings);
});

/** Answers "did cleanup actually run?", the first thing an admin asks. */
lifecycleRoutes.get('/jobs', async (c) => {
  const runs = await recentJobRuns(50);

  return c.json({
    runs: runs.map((run) => ({
      id: run.id,
      jobName: run.jobName,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.durationMs,
      itemsProcessed: run.itemsProcessed,
      status: run.status,
      errorMessage: run.errorMessage,
    })),
  });
});

lifecycleRoutes.post('/jobs/:name/run', async (c) => {
  const actor = currentUser(c);
  const name = c.req.param('name');
  const processed = await runJobNow(name);

  if (processed === null) {
    // Null also means another replica holds the lock, which is not an error.
    return c.json({ ok: true, skipped: true, itemsProcessed: 0 });
  }

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'job.run',
    targetType: 'job',
    targetId: name,
    metadata: { itemsProcessed: processed },
  });

  return c.json({ ok: true, skipped: false, itemsProcessed: processed });
});

lifecycleRoutes.get('/storage-health', async (c) => {
  const [totals, pendingDeletions] = await Promise.all([storageTotals(), pendingDeletionCount()]);
  return c.json({ ...totals, pendingDeletions });
});

/**
 * Compares storage against the database. Read-only by default: deleting
 * orphans is a separate, explicit choice.
 */
lifecycleRoutes.post('/storage-reconcile', async (c) => {
  const actor = currentUser(c);
  const deleteOrphans = c.req.query('deleteOrphans') === 'true';
  const report = await reconcileStorage({ deleteOrphans });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.reconcile',
    targetType: 'storage',
    targetId: 'reconcile',
    metadata: { ...report, deleteOrphans },
  });

  return c.json(report);
});

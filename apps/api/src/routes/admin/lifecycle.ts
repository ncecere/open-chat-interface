import { and, eq, schema } from '@oci/db';
import {
  USER_ROLES,
  type UserRole,
  updateRateLimitSettingsSchema,
  updateRetentionSettingsSchema,
  upsertStoragePolicySchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { latestJobRuns, lifecycleJobs, runOrQueueJobNow } from '../../services/jobs/index.js';
import {
  getConfigSources,
  getRateLimitSettings,
  getRetentionSettings,
  updateRateLimitSettings,
  updateRetentionSettings,
} from '../../services/lifecycle/settings.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { diffSettings } from '../../services/settings-diff.js';
import { listStoragePolicies, storageTotals } from '../../services/storage/quota.js';
import { pendingDeletionCount, reconcileStorage } from '../../services/storage/reaper.js';

export const lifecycleRoutes = new Hono<AppBindings>();

lifecycleRoutes.get('/storage-policies', async (c) => {
  return c.json({ policies: await listStoragePolicies() });
});

/** A storage allowance's values, as its audit entries record them. */
const STORAGE_POLICY_VALUES = {
  maxTotalBytes: schema.storagePolicy.maxTotalBytes,
  maxFileCount: schema.storagePolicy.maxFileCount,
  maxFileBytes: schema.storagePolicy.maxFileBytes,
  enabled: schema.storagePolicy.enabled,
};

/** The role a storage-policy URL names; 404 for anything that is not a role. */
function roleFromPath(value: string): UserRole {
  if (!(USER_ROLES as readonly string[]).includes(value)) throw notFound('Unknown role');
  return value as UserRole;
}

lifecycleRoutes.put('/storage-policies/:role', async (c) => {
  const actor = currentUser(c);
  // The URL names the role. The body may repeat it, but a body naming another
  // role is refused rather than quietly updating that one instead (#141).
  const role = roleFromPath(c.req.param('role'));
  const input = await parseBody(c, upsertStoragePolicySchema);
  if (input.role !== undefined && input.role !== role) {
    throw validationFailed('The role in the body must match the URL.', [
      {
        path: ['role'],
        message: `This URL updates the ${role} allowance; leave role out or send "${role}".`,
      },
    ]);
  }
  const organizationId = await getDefaultOrganizationId();
  const next = {
    maxTotalBytes: input.maxTotalBytes ?? null,
    maxFileCount: input.maxFileCount ?? null,
    maxFileBytes: input.maxFileBytes ?? null,
    enabled: input.enabled,
  };
  // Read first, so the audit entry says what each value was as well as what
  // it became (#148).
  const [previous] = await db
    .select(STORAGE_POLICY_VALUES)
    .from(schema.storagePolicy)
    .where(
      and(
        eq(schema.storagePolicy.organizationId, organizationId),
        eq(schema.storagePolicy.role, role),
      ),
    )
    .limit(1);

  await db
    .insert(schema.storagePolicy)
    .values({ organizationId, role, ...next })
    .onConflictDoUpdate({
      target: [schema.storagePolicy.organizationId, schema.storagePolicy.role],
      set: { ...next, updatedAt: new Date() },
    });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.policy.update',
    targetType: 'storage_policy',
    targetId: role,
    // Each changed value as it was and as it became (null before a first save).
    metadata: { ...next, changes: diffSettings(previous ?? {}, next) },
  });

  return c.json({ ok: true });
});

lifecycleRoutes.delete('/storage-policies/:role', async (c) => {
  const actor = currentUser(c);
  const role = roleFromPath(c.req.param('role'));
  const organizationId = await getDefaultOrganizationId();

  const removed = await db
    .delete(schema.storagePolicy)
    .where(
      and(
        eq(schema.storagePolicy.organizationId, organizationId),
        eq(schema.storagePolicy.role, role),
      ),
    )
    .returning(STORAGE_POLICY_VALUES);

  const [policy] = removed;
  if (!policy) throw notFound('Storage policy not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'storage.policy.delete',
    targetType: 'storage_policy',
    targetId: role,
    // What was removed, so it can be put back (#148).
    metadata: { ...policy },
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

/**
 * Which retention and rate-limit values come from saved settings, environment
 * variables or built-in defaults. Separate from the settings bodies, which are
 * sent back on save and validated strictly.
 */
lifecycleRoutes.get('/config-sources', async (c) => c.json(await getConfigSources()));

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

/**
 * Answers "did cleanup actually run?", the first thing an admin asks: every
 * registered job with its most recent run (null before its first), whatever
 * its schedule. A daily job listed only while its run was among the newest
 * few dozen had no row and no Run button most of the day (#215).
 */
lifecycleRoutes.get('/jobs', async (c) => {
  const registered = lifecycleJobs();
  const runs = await latestJobRuns(registered.map((job) => job.name));
  const byName = new Map(runs.map((run) => [run.jobName, run]));

  return c.json({
    jobs: registered.map((job) => {
      const run = byName.get(job.name);
      return {
        name: job.name,
        intervalMs: job.intervalMs,
        lastRun: run
          ? {
              id: run.id,
              jobName: run.jobName,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              durationMs: run.durationMs,
              itemsProcessed: run.itemsProcessed,
              status: run.status,
              errorMessage: run.errorMessage,
            }
          : null,
      };
    }),
  });
});

lifecycleRoutes.post('/jobs/:name/run', async (c) => {
  const actor = currentUser(c);
  const name = c.req.param('name');
  const processed = await runOrQueueJobNow(name);

  if (processed === null) {
    // Null also means another replica holds the lock, which is not an error.
    return c.json({ ok: true, skipped: true, itemsProcessed: 0 });
  }

  if (processed === 'queued') {
    // OCI_ROLE=web (v0.11): a worker runs it; its run appears in the list.
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'job.run',
      targetType: 'job',
      targetId: name,
      metadata: { queued: true },
    });
    return c.json({ ok: true, skipped: false, queued: true, itemsProcessed: 0 });
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

import { eq, schema } from '@oci/db';
import {
  type AdminClassification,
  createDataClassSchema,
  setDataClassIdsSchema,
  updateClassificationSettingsSchema,
  updateDataClassSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { classificationSettings } from '../../services/classification/config.js';
import { THREAD_CONNECTOR_USE_MIGRATION } from '../../services/classification/resolve.js';
import {
  createClass,
  deleteClass,
  listAdminClasses,
  listClasses,
  listUserProjectsWithClasses,
  namesOf,
  retireClass,
  setProjectClasses,
  unreviewedConnectorCount,
  updateClass,
} from '../../services/classification/store.js';
import { isBackgroundMigrationDone } from '../../services/migrations/readiness.js';
import { updateSetting } from '../../services/settings.js';

/**
 * Administrators define data classes (#395). `requireAdmin` is applied by the
 * admin router: auditors read, only administrators write. See
 * docs/admin/data-classification.md.
 */
export const dataClassRoutes = new Hono<AppBindings>();

/** A class that exists (the caller just created, changed or found it) with its usage counts. */
async function adminClass(id: string) {
  return (await listAdminClasses()).find((entry) => entry.id === id)!;
}

/** Every class, retired ones included, with where each is used. */
dataClassRoutes.get('/', async (c) => c.json({ classes: await listAdminClasses() }));

dataClassRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createDataClassSchema);
  const created = await createClass(input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'data_class.create',
    targetType: 'data_class',
    targetId: created.id,
    metadata: { name: created.name },
  });
  return c.json(await adminClass(created.id), 201);
});

/** A rename keeps the id, so every label and approval follows; the audit entry names both. */
dataClassRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateDataClassSchema);
  const { before, after } = await updateClass(c.req.param('id'), input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'data_class.update',
    targetType: 'data_class',
    targetId: before.id,
    metadata: {
      name: after.name,
      changes: {
        ...(before.name !== after.name && { name: { before: before.name, after: after.name } }),
        ...(before.description !== after.description && {
          description: { changed: true },
        }),
      },
    },
  });
  return c.json(await adminClass(before.id));
});

/** Hides the class from pickers and refuses new labels; existing labels and approvals still count. */
dataClassRoutes.post('/:id/retire', async (c) => {
  const actor = currentUser(c);
  const { class: retired, changed } = await retireClass(c.req.param('id'));
  if (changed)
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'data_class.retire',
      targetType: 'data_class',
      targetId: retired.id,
      metadata: { name: retired.name },
    });
  return c.json(await adminClass(retired.id));
});

/** Only a class nothing refers to; 409 with counts otherwise. There is no force. */
dataClassRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const removed = await deleteClass(c.req.param('id'));
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'data_class.delete',
    targetType: 'data_class',
    targetId: removed.id,
    metadata: { name: removed.name },
  });
  return c.json({ ok: true });
});

/** The mode and the approvals of outside services, and what an administrator needs to turn it on. */
export const classificationSettingsRoutes = new Hono<AppBindings>();

async function adminClassification(): Promise<AdminClassification> {
  const settings = await classificationSettings();
  const [scheduled] = await db
    .select({ name: schema.backgroundMigration.name })
    .from(schema.backgroundMigration)
    .where(eq(schema.backgroundMigration.name, THREAD_CONNECTOR_USE_MIGRATION))
    .limit(1);
  return {
    ...settings,
    modeAvailable: Boolean(scheduled),
    backfillDone: await isBackgroundMigrationDone(THREAD_CONNECTOR_USE_MIGRATION),
    unreviewedConnectorCount: await unreviewedConnectorCount(),
  };
}

classificationSettingsRoutes.get('/', async (c) => c.json(await adminClassification()));

classificationSettingsRoutes.patch('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateClassificationSettingsSchema);
  const before = await classificationSettings();
  const next = {
    mode: input.mode ?? before.mode,
    services: { ...before.services, ...input.services },
  };
  // Until `migrate --post` has scheduled the backfill every replica runs 0.14,
  // and a v0.13 replica neither enforces nor records connector use.
  if (input.mode && input.mode !== 'off' && !(await adminClassification()).modeAvailable)
    throw conflict(
      'Warn and block cannot be turned on until the upgrade to 0.14 has finished on every server. Run "migrate --post" (see the upgrade notes), then try again.',
    );
  const mentioned = [...new Set(Object.values(input.services ?? {}).flat())];
  if (mentioned.length) {
    const known = await listClasses({ includeRetired: true });
    if (mentioned.some((id) => !known.some((entry) => entry.id === id)))
      throw validationFailed('One of those data classes does not exist.');
  }
  await updateSetting('classification', next);
  const names = async (ids: string[]) => namesOf(ids);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'settings.classification.update',
    targetType: 'setting',
    targetId: 'classification',
    metadata: {
      ...(next.mode !== before.mode && { mode: { before: before.mode, after: next.mode } }),
      services: Object.fromEntries(
        await Promise.all(
          (['webSearch', 'embeddings', 'reranking'] as const)
            .filter((name) => input.services?.[name] !== undefined)
            .map(async (name) => [
              name,
              {
                before: await names(before.services[name]),
                after: await names(next.services[name]),
              },
            ]),
        ),
      ),
    },
  });
  return c.json(await adminClassification());
});

/**
 * Labels on a person's project, set by an administrator (locked: only an
 * administrator removes them). The owner's project name is shown to
 * administrators in user detail only.
 */
export const adminProjectLabelRoutes = new Hono<AppBindings>();

adminProjectLabelRoutes.put('/:id/data-classes', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, setDataClassIdsSchema);
  const projectId = c.req.param('id');
  const result = await setProjectClasses(projectId, input.classIds, {
    userId: actor.id,
    asAdmin: true,
  });
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'project.data_classes.update',
    targetType: 'project',
    targetId: projectId,
    metadata: {
      ownerId: result.ownerId,
      by: 'admin',
      before: await namesOf(result.before),
      after: await namesOf(result.after),
    },
  });
  const projects = await listUserProjectsWithClasses(result.ownerId);
  return c.json({ classes: projects.find((entry) => entry.id === projectId)!.classes });
});

/** `GET /admin/users/:id/projects`: a person's projects with their labels. */
export const adminUserProjectRoutes = new Hono<AppBindings>();

adminUserProjectRoutes.get('/:id/projects', async (c) => {
  const [person] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, c.req.param('id')));
  if (!person) throw notFound('User not found');
  return c.json({ projects: await listUserProjectsWithClasses(person.id) });
});

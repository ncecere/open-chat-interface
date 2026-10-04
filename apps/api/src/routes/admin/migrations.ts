import { updateBackgroundMigrationSchema } from '@oci/shared';
import { Hono } from 'hono';
import { sql } from '../../db/index.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import {
  listBackgroundMigrations,
  pauseBackgroundMigration,
  resumeBackgroundMigration,
  updateBackgroundMigration,
} from '../../services/migrations/background-admin.js';
import { upgradeReport } from '../../services/migrations/preflight.js';

/**
 * System health, Upgrades and Background work (v0.11 design, sections 1 and
 * 6). Reads are open to auditors; pausing, resuming and changing a
 * migration's pace are administrator actions (requireAdmin refuses other
 * methods to auditors) and audited.
 */
export const migrationRoutes = new Hono<AppBindings>();

/** The upgrade preflight for this database and the running release. */
migrationRoutes.get('/upgrade', async (c) => c.json(await upgradeReport(sql)));

migrationRoutes.get('/background', async (c) =>
  c.json({ migrations: await listBackgroundMigrations(sql) }),
);

migrationRoutes.post('/background/:name/pause', async (c) => {
  const actor = currentUser(c);
  const name = c.req.param('name');
  const migration = await pauseBackgroundMigration(sql, name);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'background_migration.pause',
    targetType: 'background_migration',
    targetId: name,
    metadata: { cursor: migration.cursor, rowsProcessed: migration.rowsProcessed },
  });
  return c.json(migration);
});

migrationRoutes.post('/background/:name/resume', async (c) => {
  const actor = currentUser(c);
  const name = c.req.param('name');
  const migration = await resumeBackgroundMigration(sql, name);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'background_migration.resume',
    targetType: 'background_migration',
    targetId: name,
    metadata: { cursor: migration.cursor, rowsProcessed: migration.rowsProcessed },
  });
  return c.json(migration);
});

migrationRoutes.patch('/background/:name', async (c) => {
  const actor = currentUser(c);
  const name = c.req.param('name');
  const input = await parseBody(c, updateBackgroundMigrationSchema);
  const migration = await updateBackgroundMigration(sql, name, input);
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'background_migration.update',
    targetType: 'background_migration',
    targetId: name,
    metadata: input,
  });
  return c.json(migration);
});

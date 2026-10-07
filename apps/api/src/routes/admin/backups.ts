import { updateBackupSettingsSchema } from '@oci/shared';
import { Hono } from 'hono';
import { conflict, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { destinationAuditDetails, failedReason } from '../../services/audit-test-details.js';
import { pgDumpVersion } from '../../services/backups/pg-tools.js';
import { backupStatus, startManualBackup, testBackupTarget } from '../../services/backups/run.js';
import {
  applyBackupSettingsPatch,
  backupConfigurationIssues,
  backupSettings,
  changedBackupFields,
  saveBackupSettings,
} from '../../services/backups/settings.js';

/**
 * Data & storage → Backups. Auditors may read everything here; every change
 * is refused for them by `requireAdmin`.
 */
export const backupRoutes = new Hono<AppBindings>();

/** Settings, configuration problems, run history and what runs next. */
backupRoutes.get('/', async (c) => c.json(await backupStatus()));

/**
 * Changes backup settings; only sent fields change. Turning backups on is
 * refused while the destination is incomplete or pg_dump is missing, so a
 * schedule that cannot succeed is never silently "on".
 */
backupRoutes.patch('/settings', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateBackupSettingsSchema);
  const before = await backupSettings();
  const next = applyBackupSettingsPatch(before, input);

  if (next.enabled) {
    const issues = await backupConfigurationIssues(next);
    if (!(await pgDumpVersion()))
      issues.push(
        'pg_dump was not found on this server. Install the PostgreSQL client tools or set BACKUP_PG_BIN_DIR.',
      );
    if (issues.length > 0)
      throw validationFailed(`Backups cannot be turned on yet. ${issues.join(' ')}`, { issues });
  }

  const fields = changedBackupFields(before, next);
  if (fields.length > 0) {
    await saveBackupSettings(next);
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'backup.settings.update',
      targetType: 'settings',
      targetId: 'backups',
      // Which fields changed, never a credential.
      metadata: { fields, enabled: next.enabled, destination: next.destination },
    });
  }
  return c.json(await backupStatus());
});

/** Starts a backup now, in the background. The run appears in the history. */
backupRoutes.post('/run', async (c) => {
  const actor = currentUser(c);
  const settings = await backupSettings();
  const issues = await backupConfigurationIssues(settings);
  if (issues.length > 0) throw validationFailed(issues.join(' '), { issues });
  const outcome = await startManualBackup({ id: actor.id, email: actor.email });
  if (outcome === 'running') throw conflict('A backup is already running.');
  return c.json({ started: true }, 202);
});

/** Writes, reads back and deletes a small object at the saved destination. */
backupRoutes.post('/test', async (c) => {
  const actor = currentUser(c);
  const settings = await backupSettings();
  let result: { ok: boolean; detail: string };
  try {
    await testBackupTarget(settings);
    result = { ok: true, detail: 'The destination accepted, returned and deleted a test object.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ok: false, detail: message.slice(0, 300) };
  }
  // Audited as every other Test button is: it reaches an address an
  // administrator chose (#287). A failure says where and why (#343).
  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'backup.test',
    targetType: 'instance',
    metadata: {
      ok: result.ok,
      ...destinationAuditDetails(settings),
      ...failedReason(result, result.detail),
    },
  });
  return c.json(result);
});

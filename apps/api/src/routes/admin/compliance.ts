import {
  liftLegalHoldSchema,
  placeLegalHoldSchema,
  updateComplianceSettingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { clientIp } from '../../lib/client-ip.js';
import { conflict, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { resetCursorToNow } from '../../services/compliance/cursor.js';
import {
  complianceStatus,
  startManualComplianceExport,
  testComplianceTarget,
} from '../../services/compliance/export.js';
import { liftLegalHold, listLegalHolds, placeLegalHold } from '../../services/compliance/holds.js';
import {
  applyComplianceSettingsPatch,
  changedComplianceFields,
  complianceConfigurationIssues,
  complianceSettings,
  saveComplianceSettings,
} from '../../services/compliance/settings.js';

/**
 * Data & storage → Compliance: the export of audit events (and, when turned
 * on, conversation content) and legal holds. Auditors may read everything
 * here; every change is refused for them by `requireAdmin`.
 */
export const complianceRoutes = new Hono<AppBindings>();

/** Settings, configuration problems, cursors, run history and holds. */
complianceRoutes.get('/', async (c) => c.json(await complianceStatus()));

/**
 * Changes export settings; only sent fields change. Turning the export on is
 * refused while the destination is incomplete. Turning conversation content
 * on starts that stream from now: content written before is not exported.
 */
complianceRoutes.patch('/settings', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateComplianceSettingsSchema);
  const before = await complianceSettings();
  const next = applyComplianceSettingsPatch(before, input);

  if (next.enabled) {
    const issues = await complianceConfigurationIssues(next);
    if (issues.length > 0)
      throw validationFailed(`The export cannot be turned on yet. ${issues.join(' ')}`, {
        issues,
      });
  }

  const fields = changedComplianceFields(before, next);
  if (fields.length > 0) {
    if (next.includeContent && !before.includeContent) {
      try {
        await resetCursorToNow('messages');
      } catch {
        throw conflict(
          'Conversations are being written right now, so content export could not start. Try again in a moment.',
        );
      }
    }
    await saveComplianceSettings(next);
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'compliance.settings.update',
      targetType: 'settings',
      targetId: 'compliance',
      ipAddress: clientIp(c),
      // Which fields changed, never a credential.
      metadata: {
        fields,
        enabled: next.enabled,
        includeContent: next.includeContent,
        destination: next.destination,
      },
    });
  }
  return c.json(await complianceStatus());
});

/** Starts an export now, in the background. The run appears in the history. */
complianceRoutes.post('/run', async (c) => {
  const actor = currentUser(c);
  const issues = await complianceConfigurationIssues(await complianceSettings());
  if (issues.length > 0) throw validationFailed(issues.join(' '), { issues });
  const outcome = await startManualComplianceExport({ id: actor.id, email: actor.email });
  if (outcome === 'running') throw conflict('An export is already running.');
  return c.json({ started: true }, 202);
});

/** Writes, reads back and deletes a small object at the saved destination. */
complianceRoutes.post('/test', async (c) => {
  try {
    await testComplianceTarget(await complianceSettings());
    return c.json({
      ok: true,
      detail: 'The destination accepted, returned and deleted a test object.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, detail: message.slice(0, 300) });
  }
});

/** Active holds, then lifted ones. */
complianceRoutes.get('/holds', async (c) =>
  c.json({ holds: await listLegalHolds({ includeLifted: true }) }),
);

/** Places a hold on one person. Audited as `compliance.hold.place`. */
complianceRoutes.post('/holds', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, placeLegalHoldSchema);
  const hold = await placeLegalHold({ id: actor.id, email: actor.email }, input, clientIp(c));
  return c.json({ hold }, 201);
});

/** Lifts an active hold. Audited as `compliance.hold.lift`. */
complianceRoutes.post('/holds/:id/lift', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, liftLegalHoldSchema);
  const hold = await liftLegalHold(
    { id: actor.id, email: actor.email },
    c.req.param('id'),
    input,
    clientIp(c),
  );
  return c.json({ hold });
});

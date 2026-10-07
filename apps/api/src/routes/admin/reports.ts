import { desc, eq, schema } from '@oci/db';
import { patchSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { clientIp } from '../../lib/client-ip.js';
import { notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { nextReportRunAt, runDueReports } from '../../services/reports.js';
import { diffUpdate } from '../../services/settings-diff.js';

export const reportRoutes = new Hono<AppBindings>();

const reportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  windowDays: z.number().int().min(1).max(365).default(30),
  recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20),
  enabled: z.boolean().default(true),
});

reportRoutes.get('/', async (c) => {
  const rows = await db
    .select()
    .from(schema.scheduledReport)
    .orderBy(desc(schema.scheduledReport.createdAt));

  const now = new Date();
  return c.json({
    reports: rows.map((row) => ({
      ...row,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      nextRunAt: nextReportRunAt(row, now)?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
});

reportRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, reportSchema);
  const organizationId = await getDefaultOrganizationId();

  const [row] = await db
    .insert(schema.scheduledReport)
    .values({ organizationId, ...input })
    .returning({ id: schema.scheduledReport.id });

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'report.create',
    targetType: 'scheduled_report',
    targetId: row?.id ?? null,
    ipAddress: clientIp(c),
    metadata: { name: input.name, cadence: input.cadence, recipients: input.recipients.length },
  });

  return c.json({ id: row?.id }, 201);
});

reportRoutes.patch('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const patch = await parseBody(c, patchSchema(reportSchema));
  const [existing] = await db
    .select()
    .from(schema.scheduledReport)
    .where(eq(schema.scheduledReport.id, id))
    .limit(1);

  const [updated] = await db
    .update(schema.scheduledReport)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.scheduledReport.id, id))
    .returning();

  if (!updated || !existing) throw notFound('Report not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'report.update',
    targetType: 'scheduled_report',
    targetId: id,
    ipAddress: clientIp(c),
    // Each sent value as it was and became (#258).
    metadata: { ...patch, changes: diffUpdate(existing, updated, Object.keys(patch)) },
  });

  return c.json({ ok: true });
});

reportRoutes.delete('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');

  const deleted = await db
    .delete(schema.scheduledReport)
    .where(eq(schema.scheduledReport.id, id))
    .returning({
      name: schema.scheduledReport.name,
      kind: schema.scheduledReport.kind,
      cadence: schema.scheduledReport.cadence,
      recipients: schema.scheduledReport.recipients,
    });

  const [report] = deleted;
  if (!report) throw notFound('Report not found');

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'report.delete',
    targetType: 'scheduled_report',
    targetId: id,
    metadata: report,
    ipAddress: clientIp(c),
  });

  return c.json({ ok: true });
});

/**
 * Sends every due report immediately.
 *
 * Exists so an administrator can confirm the address list and the content
 * before waiting a month to discover the recipients were wrong.
 */
reportRoutes.post('/run', async (c) => {
  const actor = currentUser(c);
  const sent = await runDueReports();

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'report.run',
    targetType: 'scheduled_report',
    ipAddress: clientIp(c),
    metadata: { sent },
  });

  return c.json({ sent });
});

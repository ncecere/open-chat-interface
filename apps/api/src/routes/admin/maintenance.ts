import { updateMaintenanceSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { scheduledJobs } from '../../services/jobs/index.js';
import { maintenanceView, updateMaintenance } from '../../services/maintenance/read-only.js';

/**
 * System health, Maintenance (v0.11 design, section 9): the read-only switch,
 * a scheduled window and the jobs that keep running. Auditors read it;
 * changing it is for administrators (requireAdmin), audited, and allowed
 * while read-only (middleware/read-only.ts), so the switch can be turned off.
 */
export const maintenanceAdminRoutes = new Hono<AppBindings>();

/**
 * The jobs Background jobs lists: those the replicas that run jobs schedule.
 * This replica's own list offered `migrations.post-deploy` on a `web` replica
 * that migrates at startup, though no worker runs it (#281, as #256).
 */
const jobNames = async () => (await scheduledJobs()).map((job) => job.name);

maintenanceAdminRoutes.get('/', async (c) => c.json(await maintenanceView(await jobNames())));

maintenanceAdminRoutes.put('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateMaintenanceSchema);
  return c.json(await updateMaintenance(input, actor, await jobNames()));
});

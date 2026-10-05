import { updateMaintenanceSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { lifecycleJobs } from '../../services/jobs/index.js';
import { maintenanceView, updateMaintenance } from '../../services/maintenance/read-only.js';

/**
 * System health, Maintenance (v0.11 design, section 9): the read-only switch,
 * a scheduled window and the jobs that keep running. Auditors read it;
 * changing it is for administrators (requireAdmin), audited, and allowed
 * while read-only (middleware/read-only.ts), so the switch can be turned off.
 */
export const maintenanceAdminRoutes = new Hono<AppBindings>();

const jobNames = () => lifecycleJobs().map((job) => job.name);

maintenanceAdminRoutes.get('/', async (c) => c.json(await maintenanceView(jobNames())));

maintenanceAdminRoutes.put('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, updateMaintenanceSchema);
  return c.json(await updateMaintenance(input, actor, jobNames()));
});

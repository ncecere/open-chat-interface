import { Hono } from 'hono';
import { type AppBindings, requireAdmin } from '../../middleware/context.js';
import { listAudit } from '../../services/audit.js';
import { inviteRoutes } from './invites.js';
import { modelRoutes } from './models.js';
import { overviewRoutes } from './overview.js';
import { providerRoutes } from './providers.js';
import { quotaRoutes } from './quotas.js';
import { settingsRoutes } from './settings.js';
import { ssoRoutes } from './sso.js';
import { userRoutes } from './users.js';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAdmin);

adminRoutes.route('/overview', overviewRoutes);
adminRoutes.route('/users', userRoutes);
adminRoutes.route('/invites', inviteRoutes);
adminRoutes.route('/providers', providerRoutes);
adminRoutes.route('/models', modelRoutes);
adminRoutes.route('/quotas', quotaRoutes);
adminRoutes.route('/settings', settingsRoutes);
adminRoutes.route('/sso', ssoRoutes);

adminRoutes.get('/audit', async (c) => {
  const entries = await listAudit(200);
  return c.json({
    entries: entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
});

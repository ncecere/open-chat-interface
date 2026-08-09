import { Hono } from 'hono';
import { type AppBindings, requireAdmin } from '../../middleware/context.js';
import { auditRoutes } from './audit.js';
import { broadcastRoutes } from './broadcasts.js';
import { healthRoutes as adminHealthRoutes } from './health.js';
import { inviteRoutes } from './invites.js';
import { lifecycleRoutes } from './lifecycle.js';
import { modelRoutes } from './models.js';
import { overrideRoutes } from './overrides.js';
import { overviewRoutes } from './overview.js';
import { policyRoutes } from './policies.js';
import { providerRoutes } from './providers.js';
import { quotaRoutes } from './quotas.js';
import { reportRoutes } from './reports.js';
import { settingsRoutes } from './settings.js';
import { ssoRoutes } from './sso.js';
import { usageRoutes } from './usage.js';
import { userRoutes } from './users.js';
import { viewRoutes } from './views.js';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAdmin);

adminRoutes.route('/overview', overviewRoutes);
// Mounted before the user routes so the override paths are not shadowed by a
// broader `/users/:id` handler.
adminRoutes.route('/users', overrideRoutes);
adminRoutes.route('/users', userRoutes);
adminRoutes.route('/invites', inviteRoutes);
adminRoutes.route('/providers', providerRoutes);
adminRoutes.route('/models', modelRoutes);
adminRoutes.route('/broadcasts', broadcastRoutes);
adminRoutes.route('/policies', policyRoutes);
adminRoutes.route('/quotas', quotaRoutes);
adminRoutes.route('/usage', usageRoutes);
adminRoutes.route('/lifecycle', lifecycleRoutes);
adminRoutes.route('/settings', settingsRoutes);
adminRoutes.route('/sso', ssoRoutes);

adminRoutes.route('/audit', auditRoutes);
adminRoutes.route('/health', adminHealthRoutes);
adminRoutes.route('/views', viewRoutes);
adminRoutes.route('/reports', reportRoutes);

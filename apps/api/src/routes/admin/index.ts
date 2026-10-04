import { Hono } from 'hono';
import { type AppBindings, requireAdmin } from '../../middleware/context.js';
import { auditRoutes } from './audit.js';
import { backupRoutes } from './backups.js';
import { broadcastRoutes } from './broadcasts.js';
import { complianceRoutes } from './compliance.js';
import { connectorRoutes } from './connectors.js';
import { embeddingsRoutes } from './embeddings.js';
import { healthRoutes as adminHealthRoutes } from './health.js';
import { inviteRoutes } from './invites.js';
import { lifecycleRoutes } from './lifecycle.js';
import { migrationRoutes } from './migrations.js';
import { modelRoutes } from './models.js';
import { overrideRoutes } from './overrides.js';
import { overviewRoutes } from './overview.js';
import { policyRoutes } from './policies.js';
import { providerRoutes } from './providers.js';
import { quotaRoutes } from './quotas.js';
import { reportRoutes } from './reports.js';
import { rerankingRoutes } from './reranking.js';
import { rolesRoutes } from './roles.js';
import { settingsRoutes } from './settings.js';
import { setupRoutes } from './setup.js';
import { ssoRoutes } from './sso.js';
import { usageRoutes } from './usage.js';
import { userRoutes } from './users.js';
import { viewRoutes } from './views.js';
import { webhookRoutes } from './webhooks.js';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use('*', requireAdmin);

adminRoutes.route('/overview', overviewRoutes);
adminRoutes.route('/setup-status', setupRoutes);
adminRoutes.route('/roles', rolesRoutes);
// Mounted before the user routes so the override paths are not shadowed by a
// broader `/users/:id` handler.
adminRoutes.route('/users', overrideRoutes);
adminRoutes.route('/users', userRoutes);
adminRoutes.route('/invites', inviteRoutes);
adminRoutes.route('/providers', providerRoutes);
adminRoutes.route('/models', modelRoutes);
adminRoutes.route('/connectors', connectorRoutes);
adminRoutes.route('/embeddings', embeddingsRoutes);
adminRoutes.route('/reranking', rerankingRoutes);
adminRoutes.route('/broadcasts', broadcastRoutes);
adminRoutes.route('/policies', policyRoutes);
adminRoutes.route('/quotas', quotaRoutes);
adminRoutes.route('/usage', usageRoutes);
adminRoutes.route('/lifecycle', lifecycleRoutes);
adminRoutes.route('/settings', settingsRoutes);
adminRoutes.route('/sso', ssoRoutes);

adminRoutes.route('/audit', auditRoutes);
adminRoutes.route('/health', adminHealthRoutes);
adminRoutes.route('/migrations', migrationRoutes);
adminRoutes.route('/views', viewRoutes);
adminRoutes.route('/reports', reportRoutes);
adminRoutes.route('/backups', backupRoutes);
adminRoutes.route('/compliance', complianceRoutes);
adminRoutes.route('/webhooks', webhookRoutes);

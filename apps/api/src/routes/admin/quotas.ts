import { upsertQuotaPolicySchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import {
  createQuotaPolicy,
  deleteQuotaPolicy,
  updateQuotaPolicy,
} from '../../services/quota/policy-admin.js';
import { loadPolicies } from '../../services/quota/policy-queries.js';

export const quotaRoutes = new Hono<AppBindings>();

quotaRoutes.get('/', async (c) => {
  const organizationId = await getDefaultOrganizationId();
  return c.json({ policies: await loadPolicies(organizationId) });
});

quotaRoutes.post('/', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, upsertQuotaPolicySchema);
  return c.json(await createQuotaPolicy(actor, input), 201);
});

quotaRoutes.put('/:id', async (c) => {
  const actor = currentUser(c);
  const id = c.req.param('id');
  const input = await parseBody(c, upsertQuotaPolicySchema);
  return c.json(await updateQuotaPolicy(actor, id, input));
});

quotaRoutes.delete('/:id', async (c) => {
  return c.json(await deleteQuotaPolicy(currentUser(c), c.req.param('id')));
});

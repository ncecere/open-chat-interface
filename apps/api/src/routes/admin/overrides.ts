import { upsertQuotaOverrideSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import {
  clearUserOverride,
  listUserOverrides,
  setUserOverride,
} from '../../services/quota/override-admin.js';

export const overrideRoutes = new Hono<AppBindings>();

/** Every policy applying to a user, with any override folded in. */
overrideRoutes.get('/:userId/quota-overrides', async (c) => {
  return c.json(await listUserOverrides(c.req.param('userId')));
});

overrideRoutes.put('/:userId/quota-overrides', async (c) => {
  const actor = currentUser(c);
  const userId = c.req.param('userId');
  const input = await parseBody(c, upsertQuotaOverrideSchema);
  return c.json(await setUserOverride(actor, userId, input));
});

overrideRoutes.delete('/:userId/quota-overrides/:policyId', async (c) => {
  return c.json(
    await clearUserOverride(currentUser(c), c.req.param('userId'), c.req.param('policyId')),
  );
});

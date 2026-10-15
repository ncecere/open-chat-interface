import { expect, type Page } from '@playwright/test';
import { ensureCatalogModels } from './catalog';

/**
 * A group for a test that scans or drives its pages: named for the run, with
 * the signed-in administrator as its manager (so Settings → Groups has
 * something to show), one budget and one model granted. Removed afterwards,
 * with the budget, so nothing is left in the database. Needs an
 * administrator's `page`.
 */
export async function withGroup(
  page: Page,
  body: (group: { id: string; name: string }) => Promise<void>,
) {
  const admin = page.request;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = `E2E a11y group ${run}`;
  let groupId: string | undefined;
  let budgetId: string | undefined;
  try {
    const me = await admin.get('/api/me');
    const { user } = (await me.json()) as { user: { email: string } };

    const models = await ensureCatalogModels(admin);
    const listed = await admin.get('/api/admin/models');
    const { models: catalog } = (await listed.json()) as {
      models: Array<{ id: string; slug: string }>;
    };
    const model = catalog.find((entry) => entry.slug === models[0].slug);
    expect(model, 'a catalog model').toBeDefined();

    const budget = await admin.post('/api/admin/quotas', {
      data: {
        name: `E2E a11y budget ${run}`,
        metric: 'messages',
        limitValue: 1000,
        windowKind: 'daily',
        roles: [],
      },
    });
    expect(budget.status(), await budget.text()).toBe(201);
    budgetId = ((await budget.json()) as { id: string }).id;

    const made = await admin.post('/api/admin/groups', {
      data: { name, description: 'Made for an accessibility scan' },
    });
    expect(made.status(), await made.text()).toBe(201);
    groupId = ((await made.json()) as { id: string }).id;

    const added = await admin.post(`/api/admin/groups/${groupId}/members`, {
      data: { emails: [user.email], role: 'manager' },
    });
    expect(added.ok(), await added.text()).toBe(true);
    const granted = await admin.put(`/api/admin/groups/${groupId}/grants`, {
      data: { policyIds: [budgetId], modelIds: [model?.id] },
    });
    expect(granted.ok(), await granted.text()).toBe(true);

    await body({ id: groupId, name });
  } finally {
    if (groupId) await admin.delete(`/api/admin/groups/${groupId}`);
    if (budgetId) await admin.delete(`/api/admin/quotas/${budgetId}`);
  }
}

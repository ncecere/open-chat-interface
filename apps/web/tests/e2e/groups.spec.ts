import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { describeViolations, scan } from './accessibility.helpers';
import { ensureCatalogModels } from './fixtures/catalog';

/**
 * Groups (v0.14, #394) in a real browser against the real API: an
 * administrator makes a group, adds people, grants a budget and a model from
 * the group's own page; a member then sees the model; a manager sees
 * Settings → Groups and adds and removes people; and the group's chips show
 * on the budget and on the person. Every account, budget, model and group
 * here is made by the test and removed at the end.
 */

const PASSWORD_SUFFIX = '-Pw1!';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function adminCredentials() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

async function signInAdmin(browser: Browser) {
  const { email, password } = adminCredentials();
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email, password);
  return { context, page };
}

interface Person {
  id: string;
  name: string;
  email: string;
  password: string;
}

/**
 * Accounts an administrator creates. Verification is lifted while they are
 * made, as the other specs do (an account made while it is required stays
 * unverified and cannot sign in), and put back after. Each is added to
 * `people` as it is made, so a failure part-way still leaves them to remove.
 */
async function createPeople(
  admin: APIRequestContext,
  run: string,
  names: string[],
  people: Person[],
) {
  const settings = await admin.get('/api/admin/settings');
  expect(settings.ok()).toBe(true);
  const { emailVerificationRequired } = (await settings.json()) as {
    emailVerificationRequired: boolean;
  };
  try {
    if (emailVerificationRequired) {
      const lifted = await admin.patch('/api/admin/settings', {
        data: { emailVerificationRequired: false },
      });
      expect(lifted.ok(), await lifted.text()).toBe(true);
    }
    for (const label of names) {
      const person = {
        name: `Groups ${label} ${run}`,
        email: `groups-${label}-${run}@example.test`,
        password: `Disposable-${run}${PASSWORD_SUFFIX}`,
      };
      const created = await admin.post('/api/admin/users', {
        data: { ...person, role: 'user' },
      });
      expect(created.status(), await created.text()).toBe(201);
      people.push({ ...person, id: ((await created.json()) as { id: string }).id });
    }
  } finally {
    if (emailVerificationRequired) {
      const restored = await admin.patch('/api/admin/settings', {
        data: { emailVerificationRequired: true },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
    }
  }
}

async function modelSlugs(page: Page) {
  const response = await page.request.get('/api/models');
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { models: Array<{ slug: string }> }).models.map(
    (model) => model.slug,
  );
}

/** The catalog's provider, and a model only a group can make visible (no role sees it). */
async function createGroupOnlyModel(admin: APIRequestContext, slug: string, displayName: string) {
  await ensureCatalogModels(admin);
  const providers = await admin.get('/api/admin/providers');
  const { providers: listed } = (await providers.json()) as {
    providers: Array<{ id: string; label: string }>;
  };
  const provider = listed.find((entry) => entry.label === 'E2E catalog provider');
  expect(provider, 'the catalog provider').toBeDefined();
  const created = await admin.post('/api/admin/models', {
    data: {
      providerId: provider?.id,
      upstreamModelId: slug,
      slug,
      displayName,
      visibleToRoles: [],
      sortOrder: 950,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

test('a group gives its members a budget and a model; a manager keeps its people', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const groupName = `E2E Biology ${run}`;
  const budgetName = `E2E Biology monthly ${run}`;
  const modelName = `E2E group model ${run}`;
  const modelSlug = `e2e-group-${run}`;

  const { context: adminContext, page: admin } = await signInAdmin(browser);
  const created: { groupId?: string; budgetId?: string; modelId?: string; people: Person[] } = {
    people: [],
  };
  const contexts = [adminContext];
  try {
    await createPeople(admin.request, run, ['member', 'manager', 'newcomer'], created.people);
    const [member, manager, newcomer] = created.people as [Person, Person, Person];
    created.modelId = await createGroupOnlyModel(admin.request, modelSlug, modelName);
    const budget = await admin.request.post('/api/admin/quotas', {
      data: {
        name: budgetName,
        metric: 'messages',
        limitValue: 1000,
        windowKind: 'daily',
        roles: [],
      },
    });
    expect(budget.status(), await budget.text()).toBe(201);
    created.budgetId = ((await budget.json()) as { id: string }).id;

    // The member, signed in before anything is granted: the model is not theirs.
    const memberContext = await browser.newContext();
    contexts.push(memberContext);
    const memberPage = await memberContext.newPage();
    await signIn(memberPage, member.email, member.password);
    expect(await modelSlugs(memberPage)).not.toContain(modelSlug);

    // --- The administrator makes the group, adds people and grants from it.
    await admin.goto('/admin/groups');
    await expect(admin.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
    await admin.getByRole('button', { name: 'New group' }).click();
    const newGroup = admin.getByRole('dialog', { name: 'New group' });
    await newGroup.getByLabel('Name').fill(groupName);
    await newGroup.getByLabel('Description (optional)').fill('Created by the browser test');
    await newGroup.getByRole('button', { name: 'Create group' }).click();
    await expect(admin.getByRole('heading', { name: groupName, level: 1 })).toBeVisible();
    created.groupId = new URL(admin.url()).pathname.split('/').pop();
    expect(created.groupId).toBeTruthy();

    // Members and a manager (the role is chosen for the people in that request).
    const emails = admin.getByLabel('Add people by email');
    await emails.fill(`${member.email}, ${newcomer.email.replace('newcomer', 'nobody')}`);
    await admin.getByRole('button', { name: 'Add people' }).click();
    const outcome = admin.getByTestId('add-outcome');
    await expect(outcome).toContainText('Added 1 person. The group now has 1 member.');
    // The address with no account stays in the box, named as such.
    await expect(outcome).toContainText('No account with this address');
    await expect(emails).toHaveValue(newcomer.email.replace('newcomer', 'nobody'));

    await emails.fill(manager.email);
    await admin.getByRole('combobox', { name: 'Role for the new people' }).click();
    await admin.getByRole('option', { name: 'Manager' }).click();
    await admin.getByRole('button', { name: 'Add people' }).click();
    await expect(outcome).toContainText('Added 1 person. The group now has 2 members.');
    const people = admin.getByRole('region', { name: 'Members of this group' });
    await expect(people).toContainText(member.email);
    await expect(people).toContainText(manager.email);
    expect(describeViolations(await scan(admin))).toBe('');

    // A grant is written from the group: one budget, one model.
    await admin.getByRole('tab', { name: 'Budgets and models' }).click();
    await admin.getByLabel(budgetName).check();
    await admin.getByLabel(modelName).check();
    await admin.getByRole('button', { name: 'Save grants' }).click();
    await expect(admin.getByText('Saved.')).toBeVisible();
    expect(describeViolations(await scan(admin))).toBe('');

    // --- The member now sees the model, and not the manager's Settings tab.
    await memberPage.reload();
    await expect(memberPage.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    expect(await modelSlugs(memberPage)).toContain(modelSlug);
    await memberPage.getByRole('combobox', { name: /Select model/ }).click();
    await expect(memberPage.getByLabel('Choose a model')).toContainText(modelName);
    await memberPage.keyboard.press('Escape');
    await memberPage.goto('/settings');
    await expect(memberPage.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(
      memberPage.getByRole('navigation', { name: 'Settings sections' }),
    ).not.toContainText('Groups');
    await memberPage.goto('/settings/groups');
    await expect(memberPage.getByText('You do not manage any groups.')).toBeVisible();

    // --- The manager sees Settings → Groups and keeps the people in it.
    const managerContext = await browser.newContext();
    contexts.push(managerContext);
    const managerPage = await managerContext.newPage();
    await signIn(managerPage, manager.email, manager.password);
    await managerPage.goto('/settings');
    await expect(managerPage.getByRole('navigation', { name: 'Settings sections' })).toContainText(
      'Groups',
    );
    await managerPage.goto('/settings/groups');
    await expect(managerPage.getByRole('heading', { name: 'Groups', level: 1 })).toBeVisible();
    await expect(
      managerPage.getByRole('heading', { name: groupName, level: 2, exact: true }),
    ).toBeVisible();
    const managed = managerPage.getByRole('region', { name: 'Members of this group' });
    await expect(managed).toContainText(member.email);
    // Nothing of what a manager may not see: no grants, no usage.
    await expect(managerPage.getByText(budgetName)).toHaveCount(0);
    await expect(managerPage.getByText(modelName)).toHaveCount(0);
    expect(describeViolations(await scan(managerPage))).toBe('');

    await managerPage.getByLabel('Add people by email').fill(newcomer.email);
    await managerPage.getByRole('button', { name: 'Add people' }).click();
    await expect(managerPage.getByTestId('add-outcome')).toContainText('Added 1 person');
    await expect(managed).toContainText(newcomer.email);

    await managerPage.getByRole('button', { name: `Remove ${newcomer.name}` }).click();
    const confirm = managerPage.getByRole('dialog', { name: `Remove ${newcomer.name}?` });
    await confirm.getByRole('button', { name: 'Remove from group' }).click();
    await expect(confirm).toBeHidden();
    await expect(managed).not.toContainText(newcomer.email);
    // Another manager's row has no Remove; their own offers Leave.
    await expect(managerPage.getByRole('button', { name: `Leave ${groupName}` })).toBeVisible();

    // --- The group's chips, read-only, on the budget and on the person.
    await admin.goto('/admin/quotas');
    const budgetRow = admin.locator('div.min-w-0.flex-1').filter({ hasText: budgetName });
    await expect(
      budgetRow.getByRole('list', { name: 'Groups with this budget' }).getByRole('link', {
        name: groupName,
      }),
    ).toBeVisible();

    await admin.goto(`/admin/users/${member.id}`);
    await expect(admin.getByRole('heading', { name: 'Groups', level: 2 })).toBeVisible();
    await expect(admin.getByRole('link', { name: groupName }).first()).toBeVisible();
    await expect(admin.getByText(`From the group ${groupName}`)).toBeVisible();
    expect(describeViolations(await scan(admin))).toBe('');

    // Takes the grants back: the member loses the model on their next request.
    await admin.goto(`/admin/groups/${created.groupId}?tab=grants`);
    await admin.getByLabel(modelName).uncheck();
    await admin.getByRole('button', { name: 'Save grants' }).click();
    await expect(admin.getByText('Saved.')).toBeVisible();
    expect(await modelSlugs(memberPage)).not.toContain(modelSlug);
  } finally {
    if (created.groupId) await admin.request.delete(`/api/admin/groups/${created.groupId}`);
    if (created.budgetId) await admin.request.delete(`/api/admin/quotas/${created.budgetId}`);
    if (created.modelId) await admin.request.delete(`/api/admin/models/${created.modelId}`);
    for (const person of created.people)
      await admin.request.delete(`/api/admin/users/${person.id}`);
    for (const context of contexts) await context.close();
  }
});

test('the group page works from the keyboard and its dialogs give focus back', async ({
  browser,
}) => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const { context, page } = await signInAdmin(browser);
  let groupId: string | undefined;
  try {
    const made = await page.request.post('/api/admin/groups', {
      data: { name: `E2E keyboard ${run}` },
    });
    expect(made.status(), await made.text()).toBe(201);
    groupId = ((await made.json()) as { id: string }).id;

    await page.goto(`/admin/groups/${groupId}`);
    await expect(
      page.getByRole('heading', { name: `E2E keyboard ${run}`, level: 1 }),
    ).toBeVisible();

    // The sections are a tab list: arrow keys move through them.
    const members = page.getByRole('tab', { name: 'Members' });
    await members.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Budgets and models' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeFocused();
    await expect(page).toHaveURL(/tab=settings/);

    // Delete opens a dialog that traps focus, says what goes, and gives focus back on Escape.
    const trigger = page.getByRole('button', { name: 'Delete group' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Delete E2E keyboard ${run}?` });
    await expect(dialog).toContainText('It has no members, budgets, models or shared projects.');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    // Deleting it from the dialog returns to the list, where it is gone.
    await trigger.click();
    await page
      .getByRole('dialog', { name: `Delete E2E keyboard ${run}?` })
      .getByRole('button', { name: 'Delete group' })
      .click();
    await expect(page).toHaveURL(/\/admin\/groups$/);
    await expect(page.getByText(`E2E keyboard ${run}`)).toHaveCount(0);
    groupId = undefined;
  } finally {
    if (groupId) await page.request.delete(`/api/admin/groups/${groupId}`);
    await context.close();
  }
});

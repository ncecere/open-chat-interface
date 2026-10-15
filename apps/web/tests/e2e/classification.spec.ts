import { createServer, type Server } from 'node:http';
import {
  type APIRequestContext,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';

/**
 * Data classification in the browser (v0.14, #395), against the real API and a
 * real database: an administrator defines a class, approves a model, turns on
 * Block and reviews connectors; a person labels a project, sees the picker keep
 * a model out of reach with the reason, loses nothing when a send is refused,
 * and is warned (not refused) in Warn mode.
 *
 * The model provider is a small OpenAI-compatible server started here, so the
 * suite can also assert that a refused send reached it zero times.
 *
 * Needs: E2E_BASE_URL, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD of an
 * administrator, and a database where `migrate --post` has run (Warn and Block
 * cannot be turned on before: docs/admin/data-classification.md). It creates
 * its own provider, models, class, connectors and person (names carry a run
 * id), signs the person in with their own account rather than the
 * administrator's, and turns classification off again when it ends.
 *
 * Serial, and left out of the mobile project (playwright.config.ts): the mode
 * is one instance-wide setting, so two projects could not switch it at once.
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const CLASS_NAME = `E2E Students ${RUN}`;
const PERSON = { email: `class-person-${RUN}@example.test`, password: `Person-${RUN}-pass-1234` };

const world = {
  provider: null as Server | null,
  providerUrl: '',
  providerCalls: [] as string[],
  providerId: '',
  classId: '',
  plain: { id: '', slug: `cw-plain-${RUN}`, name: `Plain model ${RUN}` },
  approved: { id: '', slug: `cw-approved-${RUN}`, name: `Approved model ${RUN}` },
  connectors: [] as string[],
  warnThreadId: '',
  projectId: '',
};

function baseUrl(): string {
  return process.env.E2E_BASE_URL ?? 'http://localhost:5173';
}

/** An administrator's API session, apart from any browser page. */
async function adminApi(): Promise<APIRequestContext> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl(),
    extraHTTPHeaders: { origin: new URL(baseUrl()).origin },
  });
  const signedIn = await api.post('/api/auth/sign-in/email', { data: { email, password } });
  expect(signedIn.ok()).toBe(true);
  return api;
}

async function setMode(api: APIRequestContext, mode: 'off' | 'warn' | 'block') {
  const response = await api.patch('/api/admin/classification', { data: { mode } });
  expect(response.status(), await response.text()).toBe(200);
}

/** The model provider: replies "Stub reply from <model>" and remembers who asked. */
function startProvider(): Promise<void> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
      };
      world.providerCalls.push(body.model);
      const text = `Stub reply from ${body.model}`;
      const common = { id: 'chatcmpl-e2e', created: 1_735_689_600, model: body.model };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...common,
            object: 'chat.completion',
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (choices: unknown[], extra: object = {}) =>
        response.write(
          `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices, ...extra })}\n\n`,
        );
      send([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
      send([{ index: 0, delta: { content: text }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      send([], { usage });
      response.end('data: [DONE]\n\n');
    });
  });
  world.provider = server;
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object')
        world.providerUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    }),
  );
}

async function dismissIntroduction(page: Page) {
  const skip = page.getByRole('button', { name: 'Skip for now' });
  await skip.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await expect(skip).toBeHidden();
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await dismissIntroduction(page);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

const signInAdmin = (page: Page) =>
  signIn(page, process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!);
const signInPerson = (page: Page) => signIn(page, PERSON.email, PERSON.password);

test.beforeAll(async () => {
  await startProvider();
  const admin = await adminApi();
  try {
    // Connectors can only be created unreviewed while the mode is off.
    await setMode(admin, 'off');
    const provider = await admin.post('/api/admin/providers', {
      data: {
        kind: 'openai-compatible',
        label: `Classification e2e ${RUN}`,
        baseUrl: world.providerUrl,
        apiKey: 'not-a-secret',
      },
    });
    expect(provider.status(), await provider.text()).toBe(201);
    world.providerId = ((await provider.json()) as { id: string }).id;
    for (const model of [world.plain, world.approved]) {
      const created = await admin.post('/api/admin/models', {
        data: {
          providerId: world.providerId,
          upstreamModelId: model.slug,
          slug: model.slug,
          displayName: model.name,
          capabilities: [],
          contextWindow: 32_000,
          maxOutputTokens: 4_000,
          visibleToRoles: ['admin', 'user'],
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      model.id = ((await created.json()) as { id: string }).id;
    }
    // A fresh account is created verified only while the instance does not
    // require email verification: lifted for this one call, then put back.
    const settings = await admin.get('/api/admin/settings');
    const verification = ((await settings.json()) as { emailVerificationRequired: boolean })
      .emailVerificationRequired;
    if (verification)
      expect(
        (
          await admin.patch('/api/admin/settings', { data: { emailVerificationRequired: false } })
        ).ok(),
      ).toBe(true);
    try {
      const person = await admin.post('/api/admin/users', {
        data: {
          email: PERSON.email,
          name: 'Class Person',
          password: PERSON.password,
          role: 'user',
        },
      });
      expect(person.status(), await person.text()).toBe(201);
    } finally {
      if (verification)
        await admin.patch('/api/admin/settings', { data: { emailVerificationRequired: true } });
    }
    const unreviewed = await admin.post('/api/admin/connectors', {
      data: { name: `Records ${RUN}`, url: 'https://records.example.test/mcp', authMode: 'none' },
    });
    expect(unreviewed.status(), await unreviewed.text()).toBe(201);
    world.connectors.push(((await unreviewed.json()) as { id: string }).id);
  } finally {
    await admin.dispose();
  }
});

test.afterAll(async () => {
  const admin = await adminApi();
  try {
    await setMode(admin, 'off');
    for (const id of world.connectors) await admin.delete(`/api/admin/connectors/${id}`);
    // The class stays if a conversation still carries it (there is no force);
    // the models and provider are this run's own.
    for (const model of [world.plain, world.approved])
      if (model.id) await admin.delete(`/api/admin/models/${model.id}`);
    if (world.providerId) await admin.delete(`/api/admin/providers/${world.providerId}`);
  } finally {
    await admin.dispose();
    await new Promise<void>((resolve) => world.provider?.close(() => resolve()));
  }
});

test('an administrator defines a class and approves a model', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/data-classes');
  await expect(page.getByRole('heading', { name: 'Data classes', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Add data class' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(CLASS_NAME);
  await dialog.getByLabel('Description (optional)').fill('Marks and enrolment records');
  await dialog.getByRole('button', { name: 'Add data class' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByTestId('data-class').filter({ hasText: CLASS_NAME });
  await expect(row).toContainText('Marks and enrolment records');
  await expect(row).toContainText('Approved for no models');

  // The model starts approved for nothing; the dialog says so.
  await page.goto('/admin/models?tab=models');
  await page.getByRole('button', { name: `Edit ${world.approved.name}` }).click();
  const model = page.getByRole('dialog');
  const group = model.getByRole('group', { name: 'Approved for' });
  await expect(group).toContainText('No class: this model cannot receive labelled content');
  await group.getByRole('checkbox', { name: CLASS_NAME }).check();
  await expect(group).toContainText('1 class chosen.');
  await model.getByRole('button', { name: 'Save model' }).click();
  await expect(model).toBeHidden();

  // It stuck: reopening shows it, and the class page counts it.
  await page.getByRole('button', { name: `Edit ${world.approved.name}` }).click();
  await expect(
    page.getByRole('dialog').getByRole('group', { name: 'Approved for' }).getByRole('checkbox', {
      name: CLASS_NAME,
    }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await page.goto('/admin/data-classes');
  await expect(page.getByTestId('data-class').filter({ hasText: CLASS_NAME })).toContainText(
    'Approved for 1 model',
  );

  // The plain model was never approved.
  const admin = await adminApi();
  try {
    const classes = (await (await admin.get('/api/admin/data-classes')).json()) as {
      classes: Array<{ id: string; name: string }>;
    };
    world.classId = classes.classes.find((entry) => entry.name === CLASS_NAME)!.id;
    const models = (await (await admin.get('/api/admin/models')).json()) as {
      models: Array<{ slug: string; dataClassIds: string[] }>;
    };
    expect(models.models.find((entry) => entry.slug === world.approved.slug)?.dataClassIds).toEqual(
      [world.classId],
    );
    expect(models.models.find((entry) => entry.slug === world.plain.slug)?.dataClassIds).toEqual(
      [],
    );
  } finally {
    await admin.dispose();
  }
});

test('Block is turned on, and a connector nobody has reviewed is flagged', async ({ page }) => {
  await signInAdmin(page);
  await page.goto('/admin/data-classes');
  await page.getByRole('radio', { name: /^Block/ }).check();
  await page.getByRole('button', { name: 'Save changes to the mode' }).click();
  await expect(page.getByText('Mode saved.')).toBeVisible();
  // The banner counts connectors with no statement of what they carry.
  await expect(page.getByText(/still ha(s|ve) no statement of what/)).toBeVisible();

  await page.goto('/admin/connectors');
  const card = page.getByRole('region', { name: `Records ${RUN}` });
  await expect(card.getByText('Not reviewed')).toBeVisible();

  // A new connector must say what it carries, or that it carries nothing.
  await page.getByRole('button', { name: 'Add connector' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(`Wiki ${RUN}`);
  await dialog.getByLabel('Server URL').fill('https://wiki.example.test/mcp');
  await dialog.getByRole('button', { name: 'Add connector' }).click();
  await expect(
    dialog.getByText(
      'Choose the classes it carries, or confirm that it carries no classified data.',
    ),
  ).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Carries no classified data' }).check();
  await dialog.getByRole('button', { name: 'Add connector' }).click();
  await expect(dialog).toBeHidden();
  const wiki = page.getByRole('region', { name: `Wiki ${RUN}` });
  await expect(wiki.getByText('Carries no classified data')).toBeVisible();
  await expect(wiki.getByText('Not reviewed')).toBeHidden();

  // Reviewing the first one: it carries the class.
  await card.getByRole('button', { name: `Edit Records ${RUN}` }).click();
  const edit = page.getByRole('dialog');
  await edit
    .getByRole('group', { name: 'Carries' })
    .getByRole('checkbox', { name: CLASS_NAME })
    .check();
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(card.getByText(`Carries ${CLASS_NAME}`)).toBeVisible();
  await expect(card.getByText('Not reviewed')).toBeHidden();

  const admin = await adminApi();
  try {
    const connectors = (await (await admin.get('/api/admin/connectors')).json()) as {
      connectors: Array<{ id: string; name: string }>;
    };
    for (const connector of connectors.connectors)
      if (connector.name === `Wiki ${RUN}`) world.connectors.push(connector.id);
  } finally {
    await admin.dispose();
  }
});

test('a project is labelled; the picker keeps the model out of reach, with the reason', async ({
  page,
}) => {
  await signInPerson(page);
  // Their own default is the model that is not approved for anything.
  const preferred = await page.request.patch('/api/me/preferences', {
    data: { defaultModelSlug: world.plain.slug },
  });
  expect(preferred.status(), await preferred.text()).toBe(200);
  const created = await page.request.post('/api/projects', {
    data: { name: `Marks ${RUN}`, instructions: 'Answer briefly.' },
  });
  expect(created.status()).toBe(201);
  world.projectId = ((await created.json()) as { project: { id: string } }).project.id;

  // The owner labels the project in its settings.
  await page.goto(`/projects/${world.projectId}?tab=settings`);
  const section = page.getByRole('region', { name: 'Data classes' });
  await section.getByRole('button', { name: 'Add label' }).click();
  await page.getByRole('menuitem', { name: CLASS_NAME }).click();
  const chip = section.locator('[data-class-chip]').filter({ hasText: CLASS_NAME });
  await expect(chip).toContainText('added by you');
  await expect(chip.getByRole('button', { name: `Remove the ${CLASS_NAME} label` })).toBeVisible();

  // A new chat in the project does not start on the unapproved default.
  await page.goto(`/?project=${world.projectId}`);
  const trigger = page.getByRole('combobox', { name: /Select model/ });
  await expect(trigger).toHaveAccessibleName(`Select model. Current model: ${world.approved.name}`);
  await expect(page.locator('[data-classification-composer-note]')).toBeHidden();

  await trigger.click();
  const search = page.getByRole('combobox', { name: 'Search models' });
  await expect(search).toBeFocused();
  const plain = page.getByRole('option', { name: new RegExp(world.plain.name) });
  // Listed, aria-disabled, with the reason as text in its name.
  await expect(plain).toHaveAttribute('aria-disabled', 'true');
  await expect(plain).toContainText(`Not approved for ${CLASS_NAME}`);
  await expect(
    page.getByRole('option', { name: new RegExp(world.approved.name) }),
  ).not.toHaveAttribute('aria-disabled', 'true');

  // Reachable and announced from the keyboard, but not chosen.
  await page.keyboard.press('ArrowUp');
  const plainId = await plain.getAttribute('id');
  await expect(search).toHaveAttribute('aria-activedescendant', plainId!);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
  // Playwright will not click what is aria-disabled; a person can, so it is forced.
  await plain.click({ force: true });
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAccessibleName(`Select model. Current model: ${world.approved.name}`);

  // Sending with the approved model works, and the conversation shows its label.
  const before = world.providerCalls.length;
  await page.getByRole('textbox', { name: 'Message input' }).fill('Summarise the marks policy');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page).toHaveURL(/\/chat\//);
  await expect(page.getByText(`Stub reply from ${world.approved.slug}`)).toBeVisible();
  expect(world.providerCalls.slice(before)).toEqual([world.approved.slug]);
  const labelled = page.locator('[data-class-chip]').filter({ hasText: CLASS_NAME });
  await expect(labelled).toContainText('from the project');
  // It comes from the project: no remove button, and the page says why.
  await expect(labelled.getByRole('button')).toHaveCount(0);
  await expect(
    page.getByText('Labels that come from the project or a connector cannot be removed here'),
  ).toBeVisible();
});

test('chips add and remove; a blocked send keeps the text and offers the approved models', async ({
  page,
}) => {
  await signInPerson(page);
  const created = await page.request.post('/api/threads', { data: {} });
  expect(created.status()).toBe(201);
  const { thread } = (await created.json()) as { thread: { id: string } };
  await page.goto(`/chat/${thread.id}`);

  // Nothing is labelled, so the model that is not approved can be chosen.
  const trigger = page.getByRole('combobox', { name: /Select model/ });
  await trigger.click();
  await page.getByRole('option', { name: new RegExp(world.plain.name) }).click();
  await expect(trigger).toHaveAccessibleName(`Select model. Current model: ${world.plain.name}`);
  const box = page.getByRole('textbox', { name: 'Message input' });
  await box.fill('Marks for J. Smith');

  // Add a label: the chip says who added it, and the composer says what it means.
  await page.getByRole('button', { name: 'Add label' }).click();
  await page.getByRole('menuitem', { name: CLASS_NAME }).click();
  const chip = page.locator('[data-class-chip]').filter({ hasText: CLASS_NAME });
  await expect(chip).toContainText('added by you');
  await expect(page.locator('[data-classification-composer-note="blocked"]')).toContainText(
    `${world.plain.name} is not approved for ${CLASS_NAME}, which this conversation carries.`,
  );

  // Sending anyway: the server refuses, the provider is never asked, the text stays.
  const before = world.providerCalls.length;
  await page.getByRole('button', { name: 'Send message' }).click();
  const refusal = page.locator('[data-classification-blocked="send"]');
  await expect(refusal).toContainText('Your message was not sent.');
  await expect(refusal).toContainText(`not approved for ${CLASS_NAME}`);
  await expect(box).toHaveValue('Marks for J. Smith');
  expect(world.providerCalls.length).toBe(before);

  // The approved model is a button; using it lets the same text go.
  await refusal.getByRole('button', { name: `Use ${world.approved.name}` }).click();
  await expect(refusal.getByRole('status')).toContainText(`Switched to ${world.approved.name}`);
  await expect(page.locator('[data-classification-composer-note]')).toBeHidden();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(`Stub reply from ${world.approved.slug}`)).toBeVisible();
  expect(world.providerCalls.slice(before)).toEqual([world.approved.slug]);

  // A label the person added can be removed.
  await chip.getByRole('button', { name: `Remove the ${CLASS_NAME} label` }).click();
  await expect(chip).toBeHidden();
  const classification = await page.request.get(`/api/classification?threadId=${thread.id}`);
  expect(((await classification.json()) as { classes: unknown[] }).classes).toEqual([]);
});

test('in Warn the send goes ahead, with a note before and after', async ({ page }) => {
  const admin = await adminApi();
  try {
    await setMode(admin, 'warn');
  } finally {
    await admin.dispose();
  }
  await signInPerson(page);
  const created = await page.request.post('/api/threads', { data: {} });
  const { thread } = (await created.json()) as { thread: { id: string } };
  world.warnThreadId = thread.id;
  await page.request.post(`/api/threads/${thread.id}/data-classes`, {
    data: { classId: world.classId },
  });
  await page.goto(`/chat/${thread.id}`);

  const trigger = page.getByRole('combobox', { name: /Select model/ });
  await trigger.click();
  const plain = page.getByRole('option', { name: new RegExp(world.plain.name) });
  // Selectable, with an amber note, not disabled.
  await expect(plain).not.toHaveAttribute('aria-disabled', 'true');
  await expect(plain.locator('[data-classification-note="warn"]')).toContainText(
    `Not approved for ${CLASS_NAME}. You can still use it; the administrator is told.`,
  );
  await plain.click();
  await expect(page.locator('[data-classification-composer-note="warn"]')).toContainText(
    'Your message will still be sent, and the administrator will see this in the audit log.',
  );

  const before = world.providerCalls.length;
  await page.getByRole('textbox', { name: 'Message input' }).fill('Marks for A. Jones');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(`Stub reply from ${world.plain.slug}`)).toBeVisible();
  expect(world.providerCalls.slice(before)).toEqual([world.plain.slug]);
  await expect(page.locator('[data-data-classification="send"]')).toContainText(
    `This conversation carries ${CLASS_NAME}, which this model is not approved for. It was sent anyway because data classification is set to warn`,
  );

  // A share link is allowed in Warn, with a notice of what it carries.
  await page.getByRole('button', { name: 'Share conversation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share conversation' });
  await dialog.getByRole('button', { name: 'Create and copy link' }).click();
  await expect(dialog.locator('[data-share-notice]')).toContainText(
    `This conversation carries ${CLASS_NAME}, and anyone with the link can read it.`,
  );
  await expect(dialog.getByText('active', { exact: true })).toBeVisible();
});

test('back in Block, the share link of a labelled conversation is paused', async ({ page }) => {
  const admin = await adminApi();
  try {
    await setMode(admin, 'block');
  } finally {
    await admin.dispose();
  }
  await signInPerson(page);
  await page.goto(`/chat/${world.warnThreadId}`);
  await page.getByRole('button', { name: 'Share conversation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Share conversation' });
  const link = dialog.locator('li').first();
  await expect(link.getByText('paused', { exact: true })).toBeVisible();
  await expect(link).toContainText('works again if the label is removed');
  await expect(dialog.getByRole('button', { name: 'Copy share link' })).toBeDisabled();

  // A new one is refused, in the server's words.
  await dialog.getByRole('button', { name: 'Create and copy link' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This conversation cannot be shared.');
});

import { expect, test } from '@playwright/test';
import { describeViolations, scan, signIn, storeThemeForProject } from './accessibility.helpers';
import { LABELLED, openLabelledConversation } from './classification.fixtures';

/**
 * WCAG 2.2 AA scans: projects, conversations, replies, tool steps and
 * artifacts. What automation can and cannot judge: accessibility.helpers.ts.
 */

storeThemeForProject();

test.describe('WCAG 2.2 AA: authenticated surfaces', () => {
  test('a project page has no violations', async ({ page }) => {
    await signIn(page);
    // Created through the real API with the signed-in session's cookies.
    const created = await page.request.post('/api/projects', {
      data: { name: `Accessibility project ${Date.now()}`, instructions: 'Answer clearly.' },
    });
    expect(created.status()).toBe(201);
    const { project } = (await created.json()) as { project: { id: string; name: string } };

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { level: 1, name: project.name })).toBeVisible();
    await expect(page.getByText('No conversations yet.')).toBeVisible();

    // Every tab, reached with the keyboard as the tabs pattern prescribes.
    for (const [name, ready] of [
      ['Conversations', 'No conversations yet.'],
      ['Instructions', 'Answer clearly.'],
      ['Files', 'No files yet.'],
      ['Settings', 'Delete project'],
    ] as const) {
      if (name !== 'Conversations') await page.keyboard.press('ArrowRight');
      else await page.getByRole('tab', { name }).focus();
      await expect(page.getByRole('tab', { name, selected: true })).toBeFocused();
      if (name === 'Instructions')
        await expect(page.getByRole('textbox', { name: 'Instructions' })).toHaveValue(ready);
      else await expect(page.getByText(ready).first()).toBeVisible();
      const results = await scan(page);
      expect(describeViolations(results), `${name}: ${describeViolations(results)}`).toBe('');
    }
  });

  test('the sidebar project tree has no violations while expanded', async ({ page }) => {
    await signIn(page);
    const name = `Tree project ${Date.now()}`;
    const created = await page.request.post('/api/projects', { data: { name } });
    expect(created.status()).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };
    let threadId = '';
    for (const title of ['Tree first', 'Tree second']) {
      const response = await page.request.post('/api/threads', {
        data: { title, projectId: project.id },
      });
      expect(response.status()).toBe(201);
      threadId = ((await response.json()) as { thread: { id: string } }).thread.id;
    }
    // Pinned: listed in Pinned with its project named, counted under the project.
    expect(
      (await page.request.patch(`/api/threads/${threadId}`, { data: { pinned: true } })).status(),
    ).toBe(200);

    // The open conversation's project expands by itself.
    await page.goto(`/chat/${threadId}`);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    const open = page.getByRole('button', { name: 'Open sidebar' });
    if (await open.isVisible()) await open.click();
    const toggle = page.getByRole('button', { name: `Conversations in ${name}` });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByRole('list', { name: `Conversations in ${name}` }).getByRole('link'),
    ).toHaveText(['Tree first']);
    await expect(
      page.getByRole('link', { name: `Show all (2) conversations in ${name}` }),
    ).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');

    // Leave the shared fixture's Pinned section as it was.
    await page.request.patch(`/api/threads/${threadId}`, { data: { pinned: false } });
  });

  test('the move to project dialog has no violations while open', async ({ page }) => {
    await signIn(page);
    const created = await page.request.post('/api/threads', { data: { title: 'To be moved' } });
    expect(created.status()).toBe(201);
    const { thread } = (await created.json()) as { thread: { id: string } };

    await page.goto(`/chat/${thread.id}`);
    await page.getByRole('button', { name: 'Move to project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move to project' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'No project' })).toBeChecked();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('the export menu on a reply has no violations while open', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    await page.route('**/api/chat/a11y-export/messages**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-export', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-export-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'A table, please' }],
              metadata: { status: 'complete', createdAt: created },
            },
            {
              id: 'a11y-export-reply',
              role: 'assistant',
              parts: [{ type: 'text', text: '| Region | Sales |\n| --- | --- |\n| North | 12 |' }],
              metadata: { status: 'complete', createdAt: created },
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-export');
    const reply = page.getByRole('article', { name: 'Assistant message' });
    await expect(reply.getByRole('table')).toBeVisible();
    await reply.getByRole('button', { name: 'Export as\u2026' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Spreadsheet (.xlsx)' })).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('the appearance menu has no violations while open (#172)', async ({ page }) => {
    await signIn(page);
    await page.goto('/');
    // A modal menu: the page behind it is hidden and must not stay focusable.
    await page.getByRole('button', { name: 'Appearance settings' }).click();
    await expect(page.getByRole('menu')).toBeVisible();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('the reply switcher on a retried turn has no violations', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    const reply = (id: string, text: string) => ({
      id,
      role: 'assistant',
      parts: [{ type: 'text', text }],
      metadata: { status: 'complete', createdAt: created },
    });
    const replies = [reply('a11y-reply-1', 'First answer'), reply('a11y-reply-2', 'Second answer')];
    await page.route('**/api/chat/a11y-replies/messages**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-replies', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'A question' }],
              metadata: { status: 'complete', createdAt: created },
            },
            replies[1],
          ],
          replies,
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-replies');
    const group = page.getByRole('group', { name: 'Replies' });
    await expect(group.getByRole('status')).toHaveText('Reply 2 of 2');
    await group.getByRole('button', { name: 'Previous reply' }).focus();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('a tool step and an approval card have no violations', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    await page.route('**/api/chat/a11y-tools/messages**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-tools', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-tools-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'Look it up and send a note' }],
              metadata: { status: 'complete', createdAt: created },
            },
            {
              id: 'a11y-tools-reply',
              role: 'assistant',
              parts: [
                { type: 'step-start' },
                {
                  type: 'tool-web_search',
                  toolCallId: 'a11y-search',
                  state: 'output-available',
                  input: { query: 'opening hours' },
                  output: { query: 'opening hours', results: [] },
                },
                { type: 'step-start' },
                {
                  type: 'tool-send_note',
                  toolCallId: 'a11y-note',
                  title: 'Send note',
                  state: 'approval-requested',
                  input: { to: 'Ada' },
                  approval: { id: 'a11y-approval' },
                },
              ],
              metadata: { status: 'complete', createdAt: created },
            },
          ],
          replies: [],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-tools');
    const card = page.getByRole('region', { name: 'Allow Send note?' });
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible();
    await page.locator('[data-reply-group="work"] > button').click();
    await page
      .getByRole('button', { name: "Searched the web for 'opening hours' · 0 results" })
      .click();
    await card.getByRole('button', { name: 'Deny' }).focus();

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('the artifact panel and an artifact step have no violations', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    // Comments and parameters too: their GitHub colours failed contrast (#171).
    const html = [
      '<!doctype html>',
      '<title>Plan page</title>',
      '<!-- The plan, in one page -->',
      '<h1>Plan</h1>',
      '<p>Hello</p>',
      '<script>',
      '  // Adds two numbers',
      '  function add(first, second) {',
      '    return first + second;',
      '  }',
      '</script>',
    ].join('\n');
    const artifact = {
      id: 'a11y-artifact',
      threadId: 'a11y-artifacts',
      messageId: 'a11y-artifact-reply',
      sourceKey: 'tool:a11y-call',
      title: 'Plan page',
      kind: 'html',
      currentVersion: 1,
      sizeBytes: html.length,
      createdAt: created,
      updatedAt: created,
    };
    await page.route('**/api/chat/a11y-artifacts/messages**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-artifacts', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-artifact-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'A page, please' }],
              metadata: { status: 'complete', createdAt: created },
            },
            {
              id: 'a11y-artifact-reply',
              role: 'assistant',
              parts: [
                { type: 'step-start' },
                { type: 'reasoning', text: 'A short page.' },
                {
                  type: 'tool-create_artifact',
                  toolCallId: 'a11y-call',
                  state: 'output-available',
                  input: { title: 'Plan page', kind: 'html', content: html },
                  output: { artifactId: artifact.id, title: 'Plan page', kind: 'html', version: 1 },
                },
                { type: 'step-start' },
                { type: 'text', text: 'Here it is.' },
              ],
              metadata: { status: 'complete', createdAt: created },
            },
          ],
          replies: [],
        }),
      }),
    );
    await page.route('**/api/artifacts?threadId=a11y-artifacts', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ artifacts: [artifact] }),
      }),
    );
    await page.route(`**/api/artifacts/${artifact.id}`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          artifact,
          versions: [
            {
              version: 1,
              sizeBytes: html.length,
              source: 'reply',
              messageId: artifact.messageId,
              createdAt: created,
            },
          ],
          content: html,
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-artifacts');
    // The work block expanded, and the details inside the card.
    await page.getByRole('button', { name: 'Thought · created an artifact' }).click();
    await expect(page.getByRole('list', { name: 'Steps' })).toBeVisible();
    await page.getByRole('button', { name: 'Show details for Plan page' }).click();
    await expect(page.getByRole('button', { name: 'Open artifact (version 1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Open artifact: Plan page' }).click();
    // Docked beside the conversation on wide screens, a dialog on phones.
    const panel = page.locator('[data-artifact-panel]');
    await expect(panel).toBeVisible();
    // The source view (the preview is a sandboxed frame axe cannot enter).
    await panel.getByRole('tab', { name: 'Source' }).click();
    await expect(panel.getByRole('tabpanel', { name: 'Source' })).toContainText('Plan page');

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');

    // Full screen: a modal dialog over the whole window, same views. The browser
    // runs with a light system colour scheme and OCI's dark theme, so the
    // highlighted source must follow OCI's theme, not the system's.
    await panel.getByRole('button', { name: 'Full screen', exact: true }).click();
    const full = page.getByRole('dialog', { name: 'Plan page' });
    await expect(full).toHaveAttribute('data-full-screen', '');
    const source = full.getByRole('tabpanel', { name: 'Source' });
    await expect(source).toContainText('Plan page');
    await expect(
      source.locator('[data-streamdown="code-block-body"] span[style]').first(),
    ).toBeVisible();
    const sourceResults = await scan(page);
    expect(describeViolations(sourceResults), describeViolations(sourceResults)).toBe('');
    await full.getByRole('tab', { name: 'Versions' }).click();
    await expect(full.getByRole('tabpanel', { name: 'Versions' })).toContainText('Version 1');
    const fullResults = await scan(page);
    expect(describeViolations(fullResults), describeViolations(fullResults)).toBe('');
  });
  test('a labelled conversation, its model picker and a refused send have no violations (v0.14)', async ({
    page,
  }) => {
    await signIn(page);
    const { blockPlain } = await openLabelledConversation(page, {
      refuseSends: true,
      plainUnblockedAtFirst: true,
    });

    // Chips with their reasons, and "Add label"; the others are explained in words.
    const chips = page.getByRole('list', { name: 'Data classes' });
    await expect(chips.getByRole('listitem')).toHaveCount(4);
    await expect(chips).toContainText('from the SIS connector');
    await expect(chips).toContainText('kept from its earlier project');
    const chipResults = await scan(page);
    expect(describeViolations(chipResults), describeViolations(chipResults)).toBe('');

    // The picker, with the model the labels forbid listed and disabled.
    const trigger = page.getByRole('combobox', { name: /Select model/ });
    await trigger.click();
    await page.getByRole('option', { name: new RegExp(LABELLED.plain) }).click();
    blockPlain();
    await page.getByRole('textbox', { name: 'Message input' }).fill('Marks for J. Smith');
    // Adding a label makes the page ask again: the plain model is now refused.
    await page.getByRole('button', { name: 'Add label' }).click();
    await page.getByRole('menuitem', { name: 'Research data' }).click();
    const note = page.locator('[data-classification-composer-note="blocked"]');
    await expect(note).toContainText(`${LABELLED.plain} is not approved for`);
    await trigger.click();
    const plain = page.getByRole('option', { name: new RegExp(LABELLED.plain) });
    await expect(plain).toHaveAttribute('aria-disabled', 'true');
    await expect(plain).toContainText('Not approved for Student records and Payroll');
    const pickerResults = await scan(page);
    expect(describeViolations(pickerResults), describeViolations(pickerResults)).toBe('');
    await page.keyboard.press('Escape');

    // The refusal, with the approved models as buttons.
    await page.getByRole('button', { name: 'Send message' }).click();
    const refusal = page.locator('[data-classification-blocked="send"]');
    await expect(refusal.getByRole('button', { name: `Use ${LABELLED.approved}` })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue(
      'Marks for J. Smith',
    );
    const refusalResults = await scan(page);
    expect(describeViolations(refusalResults), describeViolations(refusalResults)).toBe('');
  });

  test('a reply sent in warn mode, with its note, has no violations (v0.14)', async ({ page }) => {
    const created = '2026-01-01T00:00:00.000Z';
    await page.route('**/api/chat/a11y-warned/messages**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          thread: { id: 'a11y-warned', temporary: false, expiresAt: null },
          messages: [
            {
              id: 'a11y-warned-prompt',
              role: 'user',
              parts: [{ type: 'text', text: 'Marks for J. Smith' }],
              metadata: { status: 'complete', createdAt: created },
            },
            {
              id: 'a11y-warned-reply',
              role: 'assistant',
              parts: [
                {
                  type: 'data-classification',
                  data: {
                    mode: 'warn',
                    point: 'send',
                    model: 'plain',
                    missing: ['Student records'],
                  },
                },
                {
                  type: 'data-project-search',
                  data: {
                    mode: 'search',
                    files: [{ name: 'handbook.pdf', passages: 1 }],
                    withheld: ['embeddings', 'reranking'],
                  },
                },
                { type: 'text', text: 'Here is a summary.' },
              ],
              metadata: { status: 'complete', createdAt: created },
            },
          ],
        }),
      }),
    );
    await signIn(page);
    await page.goto('/chat/a11y-warned');
    const reply = page.getByRole('article', { name: 'Assistant message' });
    await expect(reply).toContainText(
      'It was sent anyway because data classification is set to warn',
    );
    await expect(reply).toContainText('Meaning-based search and reranking are not approved');

    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });

  test('a share link of a labelled conversation, paused, has no violations (v0.14)', async ({
    page,
  }) => {
    await signIn(page);
    const created = await page.request.post('/api/threads', { data: { title: 'Paused link' } });
    const { thread } = (await created.json()) as { thread: { id: string } };
    const slug = 'P'.repeat(32);
    await page.route(`**/api/share-links/threads/${thread.id}`, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              links: [
                {
                  id: 'l1',
                  slug,
                  path: `/share/${slug}`,
                  upToMessageId: null,
                  viewCount: 3,
                  expiresAt: null,
                  revokedAt: null,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  paused: true,
                },
              ],
            }),
          })
        : route.continue(),
    );
    await page.goto(`/chat/${thread.id}`);
    await page.getByRole('button', { name: 'Share conversation' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share conversation' });
    await expect(dialog).toContainText('Paused: this conversation carries a data class');
    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
  test('the data classes of a project, labelled by an administrator, have no violations (v0.14)', async ({
    page,
  }) => {
    await signIn(page);
    const created = await page.request.post('/api/projects', {
      data: { name: `Labelled project ${Date.now()}` },
    });
    const { project } = (await created.json()) as { project: { id: string } };
    await page.route('**/api/classification?**', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'block',
          classes: [
            { id: 'c-locked', name: 'Student records', reasons: ['project'], locked: true },
            { id: 'c-own', name: 'Health data', reasons: ['project'], locked: false },
          ],
          models: [],
        }),
      }),
    );
    await page.route('**/api/data-classes', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ classes: [{ id: 'c-extra', name: 'Research data' }] }),
      }),
    );
    await page.goto(`/projects/${project.id}?tab=settings`);
    const section = page.getByRole('region', { name: 'Data classes' });
    await expect(section).toContainText('set by an administrator');
    await expect(section).toContainText('Labels an administrator set stay until an administrator');
    const results = await scan(page);
    expect(describeViolations(results), describeViolations(results)).toBe('');
  });
});

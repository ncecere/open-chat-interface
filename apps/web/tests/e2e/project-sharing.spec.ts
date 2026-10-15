import { expect, test } from '@playwright/test';
import { ensureCatalogModels } from './fixtures/catalog';
import {
  closeAll,
  createPeople,
  createProject,
  openSidebar,
  type Person,
  removePeople,
  shareProject,
  signInAdmin,
  signInPerson,
  uniqueRun,
  uploadProjectFile,
} from './fixtures/sharing';

/**
 * Project sharing (v0.14, #394) in a real browser against the real API: an
 * owner shares a project, the person finds it under Shared with me, uses it in
 * a conversation of their own, is promoted and demoted, loses it and sees a
 * clear page; a group share; leaving; transferring; and the Share dialog from
 * the keyboard. Every account, group and project here is made by the test and
 * removed at the end. The model provider the catalog points at is unreachable,
 * so no reply is generated: what is checked is where conversations live and
 * what each person may do.
 */

const EXPLANATION =
  "People you share with use this project's instructions and files in their own conversations, which stay private to them. Files they add count against their storage.";

test('an owner shares a project as a viewer; the person uses it, is made an editor, and loses it', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const run = uniqueRun();
  const projectName = `Lab handbook ${run}`;
  const { context: adminContext, page: admin } = await signInAdmin(browser);
  const people: Person[] = [];
  const contexts = [adminContext];
  try {
    await createPeople(admin.request, run, ['owner', 'viewer'], people);
    const [owner, viewer] = people as [Person, Person];
    await ensureCatalogModels(admin.request);

    const { context: ownerContext, page: ownerPage } = await signInPerson(browser, owner);
    contexts.push(ownerContext);
    const projectId = await createProject(ownerPage.request, projectName, 'Cite the handbook.');
    await uploadProjectFile(
      ownerPage.request,
      projectId,
      'handbook.txt',
      'Safety goggles are required.',
    );

    // --- The owner shares it with the viewer, from the Share dialog.
    await ownerPage.goto(`/projects/${projectId}`);
    await expect(ownerPage.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Share', exact: true }).click();
    const share = ownerPage.getByRole('dialog', { name: `Share “${projectName}”` });
    await expect(share).toContainText(EXPLANATION);
    await expect(share).toContainText('Not shared with anyone yet.');
    await share.getByLabel('Their email address').fill(viewer.email);
    await share.getByRole('button', { name: 'Share project' }).click();
    await expect(share.getByRole('status')).toContainText(`Shared with ${viewer.email}.`);
    const list = share.getByRole('list', { name: 'Who has access' });
    await expect(list).toContainText(viewer.name);
    await expect(list).toContainText(viewer.email);
    await expect(share).toContainText('1 of 50 shares. A group counts as one.');
    // An unknown address is said plainly and keeps what was typed.
    await share.getByLabel('Their email address').fill(`nobody-${run}@example.test`);
    await share.getByRole('button', { name: 'Share project' }).click();
    await expect(share.getByRole('alert')).toContainText('No account has that email address');
    await expect(share.getByLabel('Their email address')).toHaveValue(`nobody-${run}@example.test`);
    await ownerPage.keyboard.press('Escape');
    await expect(share).toBeHidden();

    // --- The viewer finds it under Shared with me and opens it.
    const { context: viewerContext, page: viewerPage } = await signInPerson(browser, viewer);
    contexts.push(viewerContext);
    await openSidebar(viewerPage);
    const shared = viewerPage.getByRole('list', { name: 'Shared with me' });
    await expect(shared).toContainText(projectName);
    await expect(shared).toContainText(`${owner.name} · Viewer`);
    await shared.getByRole('link', { name: new RegExp(projectName) }).click();
    await expect(viewerPage.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await expect(viewerPage.getByText(`Shared by ${owner.name} · Viewer`)).toBeVisible();

    // Reading is allowed, editing is not offered.
    await viewerPage.getByRole('tab', { name: 'Instructions' }).click();
    const instructions = viewerPage.getByRole('textbox', { name: 'Instructions' });
    await expect(instructions).toHaveValue('Cite the handbook.');
    await expect(instructions).toHaveJSProperty('readOnly', true);
    await expect(viewerPage.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await viewerPage.getByRole('tab', { name: 'Files' }).click();
    const files = viewerPage.getByRole('list', { name: 'Project files' });
    await expect(files).toContainText('handbook.txt');
    await expect(files).toContainText(`Added by ${owner.name}`);
    await expect(viewerPage.getByRole('button', { name: 'Upload files' })).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    // A viewer may download: the link is the file's own content address.
    await expect(files.getByRole('link', { name: 'handbook.txt' })).toHaveAttribute(
      'href',
      /\/api\/attachments\/.+\/content$/,
    );
    await viewerPage.getByRole('tab', { name: 'Settings' }).click();
    await expect(viewerPage.getByRole('textbox', { name: 'Project name' })).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: 'Transfer project…' })).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await expect(viewerPage.getByRole('button', { name: 'Leave project' })).toBeVisible();

    // --- The viewer starts a conversation of their own in it.
    await viewerPage.getByRole('link', { name: 'New chat in project' }).click();
    await expect(viewerPage.getByText(`New chat in ${projectName}`)).toBeVisible();
    await viewerPage
      .getByRole('textbox', { name: 'Message input' })
      .fill('What do I wear in the lab?');
    await viewerPage.getByRole('textbox', { name: 'Message input' }).press('Enter');
    await expect(viewerPage).toHaveURL(/\/chat\/[^/?]+/);
    const threadId = new URL(viewerPage.url()).pathname.split('/').pop() as string;
    const mine = await viewerPage.request.get(`/api/threads?projectId=${projectId}`);
    expect(mine.ok(), await mine.text()).toBe(true);
    expect(
      ((await mine.json()) as { threads: Array<{ id: string }> }).threads.map((t) => t.id),
    ).toContain(threadId);
    // Private: the owner's list in the same project does not hold it.
    const theirs = await ownerPage.request.get(`/api/threads?projectId=${projectId}`);
    expect(((await theirs.json()) as { threads: Array<{ id: string }> }).threads).toHaveLength(0);

    // --- The owner upgrades the viewer to editor; the editor can upload.
    await ownerPage.getByRole('button', { name: 'Share', exact: true }).click();
    await ownerPage.getByRole('combobox', { name: `Access for ${viewer.name}` }).click();
    await ownerPage.getByRole('option', { name: 'Editor' }).click();
    await expect(ownerPage.getByRole('dialog').getByRole('status')).toContainText(
      `${viewer.name} is now an editor.`,
    );
    await ownerPage.keyboard.press('Escape');

    await viewerPage.goto(`/projects/${projectId}?tab=files`);
    await expect(viewerPage.getByText(`Shared by ${owner.name} · Editor`)).toBeVisible();
    await expect(viewerPage.getByRole('button', { name: 'Upload files' })).toBeVisible();
    await viewerPage.locator('input[type="file"]').setInputFiles({
      name: 'lab-rules.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('No open shoes.'),
    });
    await expect(files.getByText('lab-rules.txt')).toBeVisible();
    await expect(
      viewerPage.getByRole('listitem').filter({ hasText: 'lab-rules.txt' }),
    ).toContainText('Added by you');
    await expect(
      viewerPage.getByRole('listitem').filter({ hasText: 'lab-rules.txt' }).getByRole('button', {
        name: 'Remove lab-rules.txt',
      }),
    ).toBeVisible();
    // The owner sees both files, and who added each.
    await ownerPage.goto(`/projects/${projectId}?tab=files`);
    await expect(
      ownerPage.getByRole('listitem').filter({ hasText: 'lab-rules.txt' }),
    ).toContainText(`Added by ${viewer.name}`);

    // --- The owner removes the share. Nothing is deleted: the conversation leaves the project,
    // and the file the editor added now belongs to the owner.
    await ownerPage.getByRole('button', { name: 'Share', exact: true }).click();
    await ownerPage.getByRole('button', { name: `Stop sharing with ${viewer.name}` }).click();
    const outcome = ownerPage.getByRole('dialog').getByRole('status');
    await expect(outcome).toContainText(`Stopped sharing with ${viewer.name}.`);
    await expect(outcome).toContainText('Their 1 conversation was kept and left the project.');
    await expect(outcome).toContainText('1 file they added now belongs to you.');
    await ownerPage.keyboard.press('Escape');
    await ownerPage.reload();
    await expect(
      ownerPage.getByRole('listitem').filter({ hasText: 'lab-rules.txt' }),
    ).toContainText('Added by you');

    // --- The viewer's open page: the next thing it asks is refused, and it says so.
    await viewerPage.getByRole('tab', { name: 'Conversations' }).click();
    await expect(
      viewerPage.getByRole('heading', { level: 1, name: 'You no longer have access' }),
    ).toBeVisible();
    await expect(viewerPage.getByRole('alert')).toContainText(
      'Your own conversations that were in it are kept',
    );
    await viewerPage.reload();
    await expect(
      viewerPage.getByRole('heading', { level: 1, name: 'Project not found' }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole('main').getByRole('link', { name: 'New chat' }),
    ).toBeVisible();
    // Gone from their lists; their conversation keeps working and left the project.
    await viewerPage.goto('/');
    await openSidebar(viewerPage);
    await expect(viewerPage.getByRole('list', { name: 'Shared with me' })).toHaveCount(0);
    await viewerPage.goto(`/chat/${threadId}`);
    await expect(viewerPage.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    const kept = await viewerPage.request.get(`/api/threads/${threadId}`);
    expect(kept.ok(), await kept.text()).toBe(true);
    expect(
      ((await kept.json()) as { thread: { projectId: string | null } }).thread.projectId,
    ).toBeNull();
  } finally {
    await removePeople(admin.request, people);
    await closeAll(contexts);
  }
});

test('a share through a group cannot be left; a direct share can, and the project goes', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const run = uniqueRun();
  const projectName = `Group notes ${run}`;
  const { context: adminContext, page: admin } = await signInAdmin(browser);
  const people: Person[] = [];
  const contexts = [adminContext];
  let groupId: string | undefined;
  try {
    await createPeople(admin.request, run, ['owner', 'member', 'direct'], people);
    const [owner, member, direct] = people as [Person, Person, Person];
    const made = await admin.request.post('/api/admin/groups', {
      data: { name: `E2E sharing group ${run}` },
    });
    expect(made.status(), await made.text()).toBe(201);
    groupId = ((await made.json()) as { id: string }).id;
    const added = await admin.request.post(`/api/admin/groups/${groupId}/members`, {
      data: { emails: [owner.email, member.email] },
    });
    expect(added.ok(), await added.text()).toBe(true);

    const { context: ownerContext, page: ownerPage } = await signInPerson(browser, owner);
    contexts.push(ownerContext);
    const projectId = await createProject(ownerPage.request, projectName);

    // --- The owner shares with the group from the dialog (only groups they are in are offered).
    await ownerPage.goto(`/projects/${projectId}`);
    await ownerPage.getByRole('button', { name: 'Share', exact: true }).click();
    const share = ownerPage.getByRole('dialog', { name: `Share “${projectName}”` });
    await share.getByRole('radio', { name: 'A group' }).check();
    await share.getByRole('combobox', { name: 'Group' }).click();
    await ownerPage.getByRole('option', { name: `E2E sharing group ${run}` }).click();
    await share.getByRole('button', { name: 'Share project' }).click();
    await expect(share.getByRole('status')).toContainText(`Shared with E2E sharing group ${run}.`);
    await expect(share.getByRole('list', { name: 'Who has access' })).toContainText(
      'Group · 2 members',
    );
    await ownerPage.keyboard.press('Escape');

    // --- The member sees it, and Leave is explained rather than offered.
    const { context: memberContext, page: memberPage } = await signInPerson(browser, member);
    contexts.push(memberContext);
    await memberPage.goto('/projects');
    // The page's own section (the sidebar has a list of the same name).
    const sharedList = memberPage
      .getByRole('region', { name: 'Shared with me' })
      .getByRole('list', { name: 'Shared with me' });
    await expect(sharedList).toContainText(projectName);
    await expect(sharedList).toContainText(`${owner.name} · Viewer`);
    await sharedList.getByRole('link', { name: new RegExp(projectName) }).click();
    await memberPage.getByRole('tab', { name: 'Settings' }).click();
    await expect(memberPage.getByText('You have access through a group')).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'Leave project' })).toHaveCount(0);
    // The server says the same.
    const refused = await memberPage.request.post(`/api/projects/${projectId}/leave`);
    expect(refused.status()).toBe(409);
    expect(
      ((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('leave_via_group');

    // --- A direct share can be left, after a confirmation that says what happens.
    await shareProject(
      ownerPage.request,
      projectId,
      { type: 'person', email: direct.email },
      'viewer',
    );
    const { context: directContext, page: directPage } = await signInPerson(browser, direct);
    contexts.push(directContext);
    await directPage.goto(`/projects/${projectId}?tab=settings`);
    await directPage.getByRole('button', { name: 'Leave project' }).click();
    const confirm = directPage.getByRole('dialog', { name: `Leave “${projectName}”?` });
    await expect(confirm).toContainText('It disappears from your lists');
    await expect(confirm).toContainText('Your conversations in it are kept');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await directPage.getByRole('button', { name: 'Leave project' }).click();
    await directPage
      .getByRole('dialog', { name: `Leave “${projectName}”?` })
      .getByRole('button', { name: 'Leave project' })
      .click();
    await expect(directPage).toHaveURL(/\/$/);
    await expect(directPage.getByText(`You left “${projectName}”.`)).toBeVisible();
    await directPage.goto('/projects');
    await expect(directPage.getByRole('list', { name: 'Shared with me' })).toHaveCount(0);
    await expect(directPage.getByText('Nothing has been shared with you yet.')).toBeVisible();
    // The group's member still has it: only the direct share went.
    await memberPage.reload();
    await expect(memberPage.getByRole('heading', { level: 1, name: projectName })).toBeVisible();

    // --- Deleting the group ends the member's access at once, with the clear state.
    await memberPage.getByRole('tab', { name: 'Files' }).click();
    const deleted = await admin.request.delete(`/api/admin/groups/${groupId}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
    groupId = undefined;
    await memberPage.getByRole('tab', { name: 'Conversations' }).click();
    await expect(
      memberPage.getByRole('heading', { level: 1, name: 'You no longer have access' }),
    ).toBeVisible();
  } finally {
    if (groupId) await admin.request.delete(`/api/admin/groups/${groupId}`);
    await removePeople(admin.request, people);
    await closeAll(contexts);
  }
});

test('ownership is transferred to a direct editor, who then holds the owner’s controls', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const run = uniqueRun();
  const projectName = `Handover ${run}`;
  const { context: adminContext, page: admin } = await signInAdmin(browser);
  const people: Person[] = [];
  const contexts = [adminContext];
  try {
    await createPeople(admin.request, run, ['owner', 'editor', 'viewer'], people);
    const [owner, editor, viewer] = people as [Person, Person, Person];
    const { context: ownerContext, page: ownerPage } = await signInPerson(browser, owner);
    contexts.push(ownerContext);
    const projectId = await createProject(ownerPage.request, projectName);
    await shareProject(
      ownerPage.request,
      projectId,
      { type: 'person', email: editor.email },
      'editor',
    );
    await shareProject(
      ownerPage.request,
      projectId,
      { type: 'person', email: viewer.email },
      'viewer',
    );

    await ownerPage.goto(`/projects/${projectId}?tab=settings`);
    await ownerPage.getByRole('button', { name: 'Transfer project…' }).click();
    const dialog = ownerPage.getByRole('dialog', { name: `Transfer “${projectName}”` });
    // Only the direct editor is offered; the viewer is not.
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await expect(dialog.getByRole('radio', { name: new RegExp(editor.name) })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Transfer project' })).toBeDisabled();
    await dialog.getByRole('radio', { name: new RegExp(editor.name) }).check();
    await expect(dialog).toContainText(`${editor.name} becomes the owner`);
    await expect(dialog).toContainText('You stay on the project as an editor');
    await dialog.getByRole('button', { name: 'Transfer project' }).click();
    await expect(dialog).toBeHidden();

    // The old owner is an editor now: no Share, Delete or Transfer.
    await expect(ownerPage.getByText(`Shared by ${editor.name} · Editor`)).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await expect(ownerPage.getByRole('button', { name: 'Delete project' })).toHaveCount(0);

    const { context: editorContext, page: editorPage } = await signInPerson(browser, editor);
    contexts.push(editorContext);
    await editorPage.goto(`/projects/${projectId}?tab=settings`);
    await expect(editorPage.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    await expect(editorPage.getByRole('button', { name: 'Delete project' })).toBeVisible();
    await expect(editorPage.getByRole('textbox', { name: 'Project name' })).toBeVisible();
  } finally {
    await removePeople(admin.request, people);
    await closeAll(contexts);
  }
});

test('the Share dialog works from the keyboard and gives focus back', async ({ browser }) => {
  test.setTimeout(180_000);
  const run = uniqueRun();
  const projectName = `Keyboard ${run}`;
  const { context: adminContext, page: admin } = await signInAdmin(browser);
  const people: Person[] = [];
  const contexts = [adminContext];
  try {
    await createPeople(admin.request, run, ['owner', 'guest'], people);
    const [owner, guest] = people as [Person, Person];
    const { context, page } = await signInPerson(browser, owner);
    contexts.push(context);
    const projectId = await createProject(page.request, projectName);
    await page.goto(`/projects/${projectId}`);

    const trigger = page.getByRole('button', { name: 'Share', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Share “${projectName}”` });
    await expect(dialog).toBeVisible();
    // Focus starts inside the dialog, on the first choice.
    await expect(dialog.getByRole('radio', { name: 'A person' })).toBeFocused();

    // Tab leaves the radio group for the email field; the address is typed.
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Their email address')).toBeFocused();
    await page.keyboard.type(guest.email);
    // Then the permission group: one stop, arrows change the choice.
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('radio', { name: 'Viewer' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.getByRole('radio', { name: 'Editor' })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Share project' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toContainText(`Shared with ${guest.email}.`);

    // Ready for the next person: focus is back in the email field, and the list follows the form.
    await expect(dialog.getByLabel('Their email address')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('radio', { name: 'Editor' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Share project' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('combobox', { name: `Access for ${guest.name}` })).toBeFocused();
    await expect(dialog.getByRole('combobox', { name: `Access for ${guest.name}` })).toContainText(
      'Editor',
    );
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('button', { name: `Stop sharing with ${guest.name}` }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    // Focus stays inside: the next Tab goes round to the dialog's own first control.
    await page.keyboard.press('Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);

    // Escape closes it and focus returns to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await removePeople(admin.request, people);
    await closeAll(contexts);
  }
});

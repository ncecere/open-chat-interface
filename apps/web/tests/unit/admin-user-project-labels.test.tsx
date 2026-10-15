// @vitest-environment happy-dom
import type { AdminDataClass, AdminUserProject } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserProjectLabels } from '../../src/components/admin/user-project-labels';
import { ApiError } from '../../src/lib/api-client';
import { alerts, button, cleanup, click, renderAdmin } from './admin-test-utils';

/** An administrator setting a person's project labels, which locks them (v0.14, #395). */
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const cls = (id: string, name: string): AdminDataClass => ({
  id,
  name,
  description: '',
  retiredAt: null,
  modelCount: 0,
  connectorCount: 0,
  projectCount: 0,
  threadCount: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
});

let root: Root | undefined;
let classes: AdminDataClass[];
let projects: AdminUserProject[];
beforeEach(() => {
  classes = [cls('c1', 'Student records'), cls('c2', 'Health data')];
  projects = [
    { id: 'p1', name: 'Thesis', classes: [{ id: 'c1', name: 'Student records', locked: true }] },
    { id: 'p2', name: 'Notes', classes: [] },
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/data-classes') return { classes };
    if (path === '/admin/users/u1/projects') return { projects };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.put.mockReset().mockResolvedValue({ classes: [] });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<UserProjectLabels userId="u1" />, { role }));
};
const text = () => document.body.textContent ?? '';
const group = (project: string) =>
  [...document.querySelectorAll('fieldset')].find(
    (node) => node.querySelector('legend')?.textContent === `Labels on ${project}`,
  )!;
const box = (project: string, label: string) =>
  [...group(project).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
    input.closest('label')?.textContent?.includes(label),
  )!;

describe('Project data classes on a person’s page', () => {
  it('lists each project by name with its labels and says which are locked', async () => {
    await render();
    expect(document.querySelector('h2')?.textContent).toBe('Project data classes');
    expect([...document.querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
      'Thesis',
      'Notes',
    ]);
    expect(box('Thesis', 'Student records').checked).toBe(true);
    expect(group('Thesis').textContent).toContain('1 is locked by an administrator.');
    expect(group('Notes').textContent).toContain('No labels.');
  });

  it('saves the whole list for one project, and says it is locked', async () => {
    await render();
    await click(box('Notes', 'Health data'));
    await click(button('Save changes to labels on Notes'));
    expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/projects/p2/data-classes', {
      classIds: ['c2'],
    });
  });

  it('lets an administrator remove a locked label, which only they can', async () => {
    await render();
    await click(box('Thesis', 'Student records'));
    await click(button('Save changes to labels on Thesis'));
    expect(api.put).toHaveBeenCalledWith('/admin/projects/p1/data-classes', { classIds: [] });
  });

  it('shows a failure at the project', async () => {
    api.put.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project not found'));
    await render();
    await click(box('Notes', 'Health data'));
    await click(button('Save changes to labels on Notes'));
    expect(alerts().join()).toContain('The labels could not be saved. Project not found');
  });

  it('has nothing to save until something changes', async () => {
    await render();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Save changes to labels on Notes"]',
      )!.disabled,
    ).toBe(true);
  });

  it('says so when the person has no projects', async () => {
    projects = [];
    await render();
    expect(text()).toContain('This person has no projects.');
  });

  it('is not on the page until a class exists', async () => {
    classes = [];
    await render();
    expect(document.body.textContent).not.toContain('Project data classes');
  });

  it('says so when the projects cannot be loaded', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/data-classes') return { classes };
      throw new ApiError(500, 'INTERNAL_ERROR', 'Down.');
    });
    await render();
    expect(alerts()).toContain('Projects could not be loaded.');
  });

  it('is read-only for an auditor', async () => {
    await render('auditor');
    expect(box('Thesis', 'Student records').closest('fieldset[disabled]')).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Save changes to labels on Thesis"]'),
    ).toBeNull();
  });
});

// @vitest-environment happy-dom
import type { ProjectSummary } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from '../../src/routes/projects/projects-list';
import { button, cleanup, click, renderAdmin } from './admin-test-utils';
import { shownTitle, TitleProbe } from './title-probe';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const base = {
  instructions: '',
  fileCount: 0,
  threadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const OWN: ProjectSummary = {
  ...base,
  id: 'p1',
  name: 'Thesis',
  fileCount: 2,
  threadCount: 3,
  access: 'owner',
};
const SHARED: ProjectSummary[] = [
  {
    ...base,
    id: 's1',
    name: 'Lab handbook',
    fileCount: 1,
    threadCount: 1,
    access: 'viewer',
    ownerName: 'Olive Owner',
  },
  { ...base, id: 's2', name: 'Grant draft', access: 'editor', ownerName: 'Edna Editor' },
];

let list: { projects: ProjectSummary[]; shared?: ProjectSummary[] };
let features: Record<string, boolean>;
let root: Root | undefined;

beforeEach(() => {
  features = { projects: true };
  list = { projects: [OWN], shared: SHARED };
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features };
    if (path === '/projects') return list;
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function render() {
  ({ root } = await renderAdmin(
    <>
      <ProjectsPage />
      <TitleProbe />
    </>,
    { path: '/projects' },
  ));
}

describe('the Projects page', () => {
  it('lists the person’s own projects and, apart, the ones shared with them', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Projects');
    expect(shownTitle()).toBe('Projects · Acme');
    const mine = document.querySelector('ul[aria-label="Your projects"]');
    expect(mine?.querySelector('a[href="/projects/p1"]')?.textContent).toContain('Thesis');
    expect(mine?.textContent).toContain('3 conversations');
    expect(mine?.textContent).toContain('2 files');
    expect(mine?.textContent).not.toContain('Lab handbook');

    const heading = [...document.querySelectorAll('h2')].find(
      (h) => h.textContent === 'Shared with me',
    );
    expect(heading).toBeDefined();
    const shared = document.querySelector('ul[aria-label="Shared with me"]');
    const rows = [...(shared?.querySelectorAll(':scope > li') ?? [])];
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
      '/projects/s1',
      '/projects/s2',
    ]);
    expect(rows[0]?.textContent).toContain('Olive Owner');
    expect(rows[0]?.textContent).toContain('Viewer');
    expect(rows[1]?.textContent).toContain('Edna Editor');
    expect(rows[1]?.textContent).toContain('Editor');
  });

  it('says what an empty Shared with me means', async () => {
    list = { projects: [OWN], shared: [] };
    await render();
    expect(document.body.textContent).toContain(
      'Nothing has been shared with you yet. When someone shares a project with you, it appears here.',
    );
    expect(document.querySelector('ul[aria-label="Shared with me"]')).toBeNull();
  });

  it('reads an API from before sharing as having nothing shared', async () => {
    list = { projects: [OWN] };
    await render();
    expect(document.body.textContent).toContain('Nothing has been shared with you yet.');
  });

  it('offers to create the first project', async () => {
    list = { projects: [], shared: SHARED };
    await render();
    expect(document.body.textContent).toContain('You have no projects of your own yet.');
    await click(button('New project'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New project');
  });

  it('explains when the role cannot use projects', async () => {
    features = { projects: false };
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Projects unavailable');
    expect(api.get).not.toHaveBeenCalledWith('/projects');
  });

  it('reports a list that could not be loaded, with a way to try again', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me') return { user: { id: 'me', name: 'Pat' }, features };
      throw new ApiError(500, 'INTERNAL_ERROR', 'Boom');
    });
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Boom');
    expect(button('Try again')).toBeTruthy();
  });
});

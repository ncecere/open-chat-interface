// @vitest-environment happy-dom
import type { SetupCheck, SetupStatus } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupChecklist } from '../../src/components/admin/setup-checklist';
import { ApiError } from '../../src/lib/api-client';
import { AdminReportsPage } from '../../src/routes/admin/reports';
import { alerts, button, cleanup, click, findButton, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function check(
  id: SetupCheck['id'],
  status: SetupCheck['status'],
  required: boolean,
  to = `/admin/${id}`,
): SetupCheck {
  return {
    id,
    title: `Title ${id}`,
    status,
    required,
    detail: `Detail ${id}.`,
    action: { label: `Open ${id}`, to },
  };
}

const inProgress: SetupStatus = {
  requiredComplete: 3,
  requiredTotal: 6,
  checks: [
    check('provider', 'complete', true),
    check('web-search', 'attention', false),
    check('models', 'complete', true),
    check('default-model', 'attention', true),
    check('storage', 'optional', false),
    check('sign-in', 'complete', true),
    check('email', 'attention', true, '/admin/settings/email'),
    check('redis', 'optional', false),
    check('acceptable-use', 'attention', true),
  ],
};

const finished: SetupStatus = {
  requiredComplete: 2,
  requiredTotal: 2,
  checks: [
    check('provider', 'complete', true),
    check('models', 'complete', true),
    check('redis', 'optional', false),
  ],
};

let status: SetupStatus = inProgress;
let root: Root | undefined;

beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  status = inProgress;
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/setup-status') return status;
    if (path === '/admin/reports') return { reports: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** Visible check titles, in document order. */
function titles(): string[] {
  return [...document.querySelectorAll('li p.font-medium')].map((node) => node.textContent ?? '');
}

describe('setup checklist', () => {
  it('shows progress and lists required attention items before optional ones', async () => {
    ({ root } = await renderAdmin(<SetupChecklist />));

    expect(document.body.textContent).toContain('3 of 6 required steps complete');
    const progress = document.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('3');
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');

    // Completed items are collapsed by default.
    expect(titles()).toEqual([
      'Title default-model',
      'Title email',
      'Title acceptable-use',
      'Title web-search',
      'Title storage',
      'Title redis',
    ]);
    expect(document.body.textContent).toContain('Optional');
  });

  it('states each status in words as well as colour', async () => {
    ({ root } = await renderAdmin(<SetupChecklist />));
    const rows = [...document.querySelectorAll('li')];
    expect(rows[0]?.textContent).toContain('Needs attention');
    expect(rows[0]?.textContent).toContain('Required');
    expect(rows[3]?.textContent).toContain('Needs attention');
    expect(rows[3]?.textContent).not.toContain('Required');
    expect(rows[4]?.textContent).toContain('Not set up');
    for (const icon of document.querySelectorAll('li svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('links each item to the page that resolves it', async () => {
    ({ root } = await renderAdmin(<SetupChecklist />));
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Open email',
    );
    expect(link?.getAttribute('href')).toBe('/admin/settings/email');
  });

  it('reveals completed items behind a disclosure', async () => {
    ({ root } = await renderAdmin(<SetupChecklist />));
    const toggle = button('Show completed (3)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await click(toggle);
    expect(button('Hide completed').getAttribute('aria-expanded')).toBe('true');
    expect(titles()).toContain('Title provider');
    expect(titles()).toContain('Title sign-in');
  });

  it('collapses to a summary once every required step is complete', async () => {
    status = finished;
    ({ root } = await renderAdmin(<SetupChecklist />));

    expect(document.querySelector('h2')?.textContent).toBe('Setup complete');
    expect(document.body.textContent).toContain('2 of 2 required steps complete');
    expect(titles()).toEqual([]);

    await click(button('Show setup details'));
    expect(titles()).toEqual(['Title redis', 'Title provider', 'Title models']);
    expect(findButton('Hide setup details')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('reports a load failure and retries', async () => {
    api.get.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'Database unavailable.'));
    ({ root } = await renderAdmin(<SetupChecklist />));

    expect(alerts()).toEqual(['Setup status could not be loaded.']);
    expect(document.body.textContent).toContain('Database unavailable.');

    await click(button('Try again'));
    expect(alerts()).toEqual([]);
    expect(document.body.textContent).toContain('3 of 6 required steps complete');
  });

  it('is shown to auditors, with links only', async () => {
    ({ root } = await renderAdmin(<SetupChecklist />, { role: 'auditor' }));
    expect(document.querySelectorAll('li a').length).toBe(6);
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('scheduled reports email notice', () => {
  it('warns that reports need email delivery until it is configured', async () => {
    ({ root } = await renderAdmin(<AdminReportsPage />));

    expect(document.body.textContent).toContain('Reports need email delivery');
    // Only the report-specific explanation; the check's own detail may be about
    // another dependent such as email verification.
    expect(document.body.textContent).not.toContain('Detail email.');
    const link = [...document.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === 'Configure email delivery',
    );
    expect(link?.getAttribute('href')).toBe('/admin/settings/email');
  });

  it('stays quiet once email delivery is complete', async () => {
    status = {
      ...inProgress,
      checks: inProgress.checks.map((entry) =>
        entry.id === 'email' ? { ...entry, status: 'complete' } : entry,
      ),
    };
    ({ root } = await renderAdmin(<AdminReportsPage />));

    expect(document.body.textContent).toContain('No reports scheduled.');
    expect(document.body.textContent).not.toContain('Reports need email delivery');
  });
});

// @vitest-environment happy-dom
import { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { MfaRequirementSection } from '../../src/routes/admin/settings/mfa-requirement';
import { button, cleanup, click, renderAdmin, settle, typeInto } from './admin-test-utils';

/**
 * The per-role requirement on Authentication settings (#399): four roles, the
 * grace, who it would limit shown before anything is saved, and what the
 * server's two refusals say.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function impact(overrides: Record<string, Partial<Record<string, unknown>>> = {}, graceDays = 14) {
  const base = {
    admin: { people: 2, exempt: 0, enrolled: 1, unenrolled: 1 },
    auditor: { people: 1, exempt: 0, enrolled: 0, unenrolled: 1 },
    user: { people: 50, exempt: 10, enrolled: 5, unenrolled: 35 },
    restricted: { people: 4, exempt: 4, enrolled: 0, unenrolled: 0 },
  } as const;
  return {
    graceDays,
    roles: (['admin', 'auditor', 'user', 'restricted'] as const).map((role) => ({
      role,
      ...base[role],
      required: false,
      since: null,
      firstDeadline: null,
      limitedNow: 0,
      ...overrides[role],
    })),
  };
}

const NONE = { roles: [] as string[], graceDays: 14, since: {} };

let root: Root | undefined;
let client: QueryClient;
let figures: ReturnType<typeof impact>;

beforeEach(() => {
  figures = impact();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/settings/mfa-impact') return structuredClone(figures);
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (
  requirement: { roles: string[]; graceDays: number; since: Record<string, string> } = NONE,
  role: 'admin' | 'auditor' = 'admin',
) => {
  ({ root } = await renderAdmin(<MfaRequirementSection requirement={requirement as never} />, {
    queryClient: client,
    role,
  }));
};
const box = (label: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => document.querySelector(`label[for="${input.id}"]`)?.textContent === label,
  )!;
const graceField = () => document.getElementById('mfa-grace-days') as HTMLInputElement;
const text = () => document.body.textContent ?? '';
const save = () => button('Save changes to the two-step verification requirement');

describe('the form', () => {
  it('has a checkbox for each of the four roles, set as saved, and the grace', async () => {
    await render({ roles: ['admin', 'user'], graceDays: 7, since: {} });
    expect(box('Admin').checked).toBe(true);
    expect(box('Auditor').checked).toBe(false);
    expect(box('User').checked).toBe(true);
    expect(box('Restricted').checked).toBe(false);
    expect(graceField().value).toBe('7');
    expect(graceField().type).toBe('number');
    expect(document.querySelector('fieldset legend, [role="group"]')).not.toBeNull();
  });

  it('warns that 0 days limits people at their next request', async () => {
    await render();
    expect(text()).toContain('0 limits people at their next request');
    await click(box('User'));
    await typeInto(graceField(), '0');
    const warning = document.querySelector('[role="alert"]');
    expect(warning?.textContent).toContain('limited at their next request');
  });

  it('has nothing to save until something changes', async () => {
    await render();
    expect(save().disabled).toBe(true);
    await click(box('User'));
    expect(save().disabled).toBe(false);
    await click(box('User'));
    expect(save().disabled).toBe(true);
  });
});

describe('who it would limit, before saving', () => {
  it('shows each role: people, no password, set up, not set up', async () => {
    await render();
    const rows = [...document.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['Admin', '2', '0', '1', '1', '0'],
      ['Auditor', '1', '0', '0', '1', '0'],
      ['User', '50', '10', '5', '35', '0'],
      ['Restricted', '4', '4', '0', '0', '0'],
    ]);
    expect([...document.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual([
      'Role',
      'People',
      'Sign in only through SSO',
      'Set up',
      'Not set up',
      'Limited now',
    ]);
  });

  it('says nobody is limited while no role is chosen', async () => {
    await render();
    expect(text()).toContain('No role is required, so nobody is limited.');
  });

  it('says how many people the chosen roles would limit, and when, as the form changes', async () => {
    await render();
    await click(box('User'));
    expect(text()).toContain('35 people would be limited after 14 days');
    await click(box('Admin'));
    expect(text()).toContain('36 people would be limited after 14 days');
    await typeInto(graceField(), '1');
    expect(text()).toContain('36 people would be limited after 1 day');
    await typeInto(graceField(), '0');
    expect(text()).toContain('36 people would be limited at their next request');
    await click(box('User'));
    await click(box('Admin'));
    await click(box('Restricted'));
    expect(text()).toContain('Nobody would be limited');
  });

  it('shows who is limited now and when the first deadline is, for a role already required', async () => {
    figures = impact({
      user: {
        required: true,
        since: '2026-10-01T00:00:00.000Z',
        firstDeadline: '2026-10-15T00:00:00.000Z',
        limitedNow: 3,
      },
    });
    await render({ roles: ['user'], graceDays: 14, since: { user: '2026-10-01T00:00:00.000Z' } });
    const user = [...document.querySelectorAll('tbody tr')].find(
      (row) => row.querySelector('th')?.textContent === 'User',
    );
    expect(user?.textContent).toContain('3');
    expect(user?.textContent).toMatch(/Oct(ober)? 1[45], 2026/);
  });

  it('says so when the figures could not be loaded, and tries again', async () => {
    api.get.mockRejectedValueOnce(new Error('down'));
    await render();
    expect(text()).toContain('The figures could not be loaded');
    await click(button('Try again'));
    expect(document.querySelectorAll('tbody tr')).toHaveLength(4);
  });
});

describe('saving', () => {
  it('sends the roles and the grace, only, and says it saved', async () => {
    await render();
    await click(box('Auditor'));
    await click(box('User'));
    await typeInto(graceField(), '30');
    await click(save());
    expect(api.patch).toHaveBeenCalledWith('/admin/settings', {
      mfaRequirement: { roles: ['auditor', 'user'], graceDays: 30 },
    });
    expect(text()).toContain('Two-step verification requirement saved.');
    expect(save().disabled).toBe(true);
  });

  it('looks at the figures again afterwards', async () => {
    await render();
    await click(box('User'));
    const reads = api.get.mock.calls.length;
    await click(save());
    await settle();
    expect(api.get.mock.calls.length).toBeGreaterThan(reads);
  });

  it('refuses a grace that is not a whole number of days from 0 to 365, in words', async () => {
    await render();
    await click(box('User'));
    for (const bad of ['', '-1', '1.5', '366', 'abc']) {
      await typeInto(graceField(), bad);
      await click(save());
      expect(text()).toContain('Enter a whole number of days from 0 to 365.');
      expect(graceField().getAttribute('aria-invalid')).toBe('true');
    }
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('says what to do when the administrator has not used a second step this session', async () => {
    api.patch.mockRejectedValueOnce(
      new ApiError(409, 'MFA_REQUIRED_FOR_ACTOR', 'server words', {
        reason: 'actor_not_satisfied',
      }),
    );
    await render();
    await click(box('User'));
    await click(save());
    const alert = [...document.querySelectorAll('[role="alert"]')].find((node) =>
      node.textContent?.includes('used it yourself'),
    );
    expect(alert?.textContent).toContain(
      'To require two-step verification you must have used it yourself in this session.',
    );
    const link = alert?.querySelector('a');
    expect(link?.textContent).toBe('Set it up under Settings → Account');
    // Nothing was saved, and what was chosen is still there to save again.
    expect(box('User').checked).toBe(true);
    expect(save().disabled).toBe(false);
  });

  it('says why administrators cannot be required before one has set it up', async () => {
    api.patch.mockRejectedValueOnce(
      new ApiError(409, 'MFA_REQUIRED_FOR_ACTOR', 'server words', { reason: 'no_enrolled_admin' }),
    );
    await render();
    await click(box('Admin'));
    await click(save());
    expect(text()).toContain(
      'Administrators cannot be required to use two-step verification until at least one local administrator has set it up.',
    );
  });

  it("keeps the server's words for any other refusal", async () => {
    api.patch.mockRejectedValueOnce(
      new ApiError(500, 'INTERNAL_ERROR', 'The setting could not be saved.'),
    );
    await render();
    await click(box('User'));
    await click(save());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'The setting could not be saved.',
    );
  });
});

describe('an auditor', () => {
  it('sees the requirement and the figures, and cannot change either', async () => {
    await render({ roles: ['user'], graceDays: 14, since: {} }, 'auditor');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(box('User').closest('fieldset[disabled]')).not.toBeNull();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
  });
});

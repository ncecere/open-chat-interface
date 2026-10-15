// @vitest-environment happy-dom
import type { AdminMfaStatus } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import { AdminUserDetailPage } from '../../src/routes/admin/user-detail';
import { button, cleanup, click, dialog, findButton, renderAdmin } from './admin-test-utils';

/**
 * A person's two-step verification on their administration page (#399):
 * auditors read it, administrators can reset it (never their own), and an
 * account that signs in only through the organisation says so.
 */
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useParams: () => ({ userId: 'user-1' }),
}));

const user = {
  id: 'user-1',
  name: 'Dana Example',
  email: 'dana@example.test',
  image: null,
  role: 'user',
  emailVerified: true,
  banned: false,
  banReason: null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  threadCount: 0,
  messageCount: 0,
};

const ON: AdminMfaStatus = {
  eligible: true,
  totp: true,
  passkeys: 2,
  recoveryCodesLeft: 8,
  lockedUntil: null,
  required: true,
  deadline: '2026-11-01T12:00:00.000Z',
};

let mfa: AdminMfaStatus | undefined;
let me: string;
let root: Root | undefined;

beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  mfa = ON;
  me = 'admin-1';
  api.get.mockImplementation(async (path: string) => {
    if (path === '/admin/users/user-1')
      return {
        user,
        ...(mfa ? { mfa } : {}),
        storage: { bytesUsed: 0, fileCount: 0 },
        sessions: [],
        recentThreads: [],
        audit: [],
      };
    if (path === '/me')
      return { user: { id: me, role: 'admin', name: 'Admin', email: 'a@example.test' } };
    if (path === '/admin/users/user-1/limits')
      return {
        usage: { allowances: [], recent: { messages: 0, tokens: 0, costMicros: 0 } },
        storage: {
          liveBytes: 0,
          liveFileCount: 0,
          pendingBytes: 0,
          pendingFileCount: 0,
          maxTotalBytes: null,
          maxFileCount: null,
          maxFileBytes: null,
        },
      };
    if (path === '/admin/users/user-1/quota-overrides') return { overrides: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockResolvedValue({ ok: true, sessionsEnded: 2 });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<AdminUserDetailPage />, { path: '/admin/users/user-1', role }));
};
const section = () =>
  [...document.querySelectorAll('section')].find(
    (candidate) => candidate.querySelector('h2')?.textContent === 'Two-step verification',
  );
const text = () => section()?.textContent ?? '';

describe('what an administrator sees', () => {
  it('is what the person has set up, whether their role requires it, and by when', async () => {
    await render();
    expect(text()).toContain('Authenticator app');
    expect(text()).toMatch(/Authenticator app\s*On/);
    expect(text()).toMatch(/Recovery codes left\s*8/);
    expect(text()).toMatch(/Passkeys\s*2/);
    expect(text()).toMatch(/Required for their role\s*Yes, by November 1, 2026/);
  });

  it('says when nothing is set up', async () => {
    mfa = {
      ...ON,
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: null,
      required: false,
      deadline: null,
    };
    await render();
    expect(text()).toMatch(/Authenticator app\s*Off/);
    expect(text()).toMatch(/Passkeys\s*None/);
    expect(text()).toMatch(/Required for their role\s*No/);
    // Nothing to reset.
    expect(findButton('Reset two-step verification')).toBeUndefined();
  });

  it('says when the second step is locked', async () => {
    mfa = { ...ON, lockedUntil: new Date(Date.now() + 600_000).toISOString() };
    await render();
    expect(text()).toContain('Locked after too many wrong codes');
  });

  it('says an account that signs in only through the organisation has none to reset', async () => {
    mfa = {
      ...ON,
      eligible: false,
      totp: false,
      passkeys: 0,
      recoveryCodesLeft: null,
      required: false,
      deadline: null,
    };
    await render();
    expect(text()).toContain('Signs in only through their organisation');
    expect(findButton('Reset two-step verification')).toBeUndefined();
  });

  it('is not shown by an API that has no two-step verification', async () => {
    mfa = undefined;
    await render();
    expect(section()).toBeUndefined();
  });
});

describe('resetting it', () => {
  it('asks first, naming the person and what it does', async () => {
    await render();
    await click(button('Reset two-step verification'));
    const box = dialog();
    expect(box?.textContent).toContain('Reset two-step verification for Dana Example?');
    expect(box?.textContent).toContain('authenticator app, recovery codes and passkeys');
    expect(box?.textContent).toContain('signs them out everywhere');
    expect(api.post).not.toHaveBeenCalled();
    await click(button('Cancel'));
    expect(dialog()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('resets it, and reads the person again', async () => {
    await render();
    await click(button('Reset two-step verification'));
    const reads = api.get.mock.calls.filter(([path]) => path === '/admin/users/user-1').length;
    await click(button('Reset and sign out'));
    expect(api.post).toHaveBeenCalledWith('/admin/users/user-1/mfa/reset', {});
    expect(dialog()).toBeNull();
    expect(
      api.get.mock.calls.filter(([path]) => path === '/admin/users/user-1').length,
    ).toBeGreaterThan(reads);
  });

  it('says why when it fails, and leaves the dialog open', async () => {
    api.post.mockRejectedValueOnce(new ApiError(500, 'INTERNAL_ERROR', 'The database is away.'));
    await render();
    await click(button('Reset two-step verification'));
    await click(button('Reset and sign out'));
    expect(dialog()?.textContent).toContain('Two-step verification could not be reset.');
  });

  it('is not offered for oneself, which is done under Settings → Account', async () => {
    me = 'user-1';
    await render();
    expect(findButton('Reset two-step verification')).toBeUndefined();
    expect(text()).toContain('Manage your own under Settings → Account.');
  });
});

describe('an auditor', () => {
  it('reads it and cannot reset it', async () => {
    await render('auditor');
    expect(text()).toMatch(/Authenticator app\s*On/);
    expect(findButton('Reset two-step verification')).toBeUndefined();
  });
});

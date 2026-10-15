// @vitest-environment happy-dom
import type { MyGroup, ProjectShare } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareProjectButton } from '../../src/components/projects/share-dialog';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  expectLocked,
  findButton,
  renderAdmin,
  typeInto,
} from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const EXPLANATION =
  "People you share with use this project's instructions and files in their own conversations, which stay private to them. Files they add count against their storage.";

const PERSON: ProjectShare = {
  id: 'share-1',
  permission: 'viewer',
  subject: { type: 'person', userId: 'u2', name: 'Vera Viewer', email: 'vera@example.test' },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const GROUP_SHARE: ProjectShare = {
  id: 'share-2',
  permission: 'editor',
  subject: { type: 'group', groupId: 'g1', name: 'Biology', memberCount: 12 },
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const GROUPS: MyGroup[] = [
  { id: 'g1', name: 'Biology', role: 'member' },
  { id: 'g2', name: 'Chemistry', role: 'manager' },
];

let shares: ProjectShare[];
let groups: MyGroup[];
let root: Root | undefined;

beforeEach(() => {
  shares = [PERSON, GROUP_SHARE];
  groups = GROUPS;
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/projects/p1/shares') return { shares };
    if (path === '/groups/mine') return { groups };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ share: PERSON });
  api.patch.mockReset().mockResolvedValue({ share: PERSON });
  api.delete.mockReset().mockResolvedValue({ ok: true, detachedThreads: 3, movedFiles: 1 });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function open() {
  ({ root } = await renderAdmin(<ShareProjectButton project={{ id: 'p1', name: 'Thesis' }} />));
  await click(button('Share'));
  return dialog()!;
}

function inDialog(name: string): HTMLButtonElement {
  const found = [...dialog()!.querySelectorAll('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name,
  );
  if (!found) throw new Error(`No button named "${name}" in the dialog`);
  return found;
}

function emailField(): HTMLInputElement {
  return dialog()!.querySelector<HTMLInputElement>('input[type="email"]')!;
}

async function choose(label: string, trigger: string) {
  await click(inDialog(trigger));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`No option named "${label}"`);
  await click(option);
}

function radio(label: string): HTMLInputElement {
  const found = [...dialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (input) => input.labels?.[0]?.textContent?.trim().startsWith(label),
  );
  if (!found) throw new Error(`No radio "${label}"`);
  return found;
}

describe('the Share dialog', () => {
  it('explains what sharing means, in the words of the spec', async () => {
    const shown = await open();
    expect(shown.getAttribute('aria-label') ?? shown.querySelector('h2')?.textContent).toContain(
      'Share “Thesis”',
    );
    expect(shown.textContent).toContain(EXPLANATION);
  });

  it('lists who has access with their level, and what the limit is', async () => {
    const shown = await open();
    const list = shown.querySelector('[aria-label="Who has access"]')!;
    const rows = [...list.querySelectorAll('li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Vera Viewer');
    expect(rows[0]?.textContent).toContain('vera@example.test');
    expect(rows[1]?.textContent).toContain('Biology');
    expect(rows[1]?.textContent).toContain('Group · 12 members');
    expect(button('Access for Vera Viewer').textContent).toContain('Viewer');
    expect(button('Access for Biology').textContent).toContain('Editor');
    expect(shown.textContent).toContain('2 of 50 shares. A group counts as one.');
  });

  it('says so when nothing is shared yet', async () => {
    shares = [];
    const shown = await open();
    expect(shown.textContent).toContain('Not shared with anyone yet.');
    expect(shown.querySelector('[aria-label="Who has access"]')).toBeNull();
  });

  it('shares with a person by exact email, as a viewer unless another level is chosen', async () => {
    await open();
    await typeInto(emailField(), '  Dana@Example.test ');
    await click(inDialog('Share project'));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/projects/p1/shares', {
      subject: { type: 'person', email: 'dana@example.test' },
      permission: 'viewer',
    });
    expect(dialog()!.querySelector('[role="status"]')?.textContent).toContain(
      'Shared with dana@example.test.',
    );
    expect(emailField().value).toBe('');
  });

  it('shares as an editor when asked', async () => {
    await open();
    await typeInto(emailField(), 'dana@example.test');
    await click(radio('Editor'));
    await click(inDialog('Share project'));
    expect(api.post).toHaveBeenCalledWith('/projects/p1/shares', {
      subject: { type: 'person', email: 'dana@example.test' },
      permission: 'editor',
    });
  });

  it('will not send an address that is not an email, and says so at the field', async () => {
    await open();
    await typeInto(emailField(), 'dana');
    await click(inDialog('Share project'));
    expect(api.post).not.toHaveBeenCalled();
    expect(alerts(dialog()!).join(' ')).toContain('Enter a full email address');
    expect(emailField().getAttribute('aria-invalid')).toBe('true');
  });

  it('shares with a group the person belongs to, leaving out groups it is already shared with', async () => {
    await open();
    await click(radio('A group'));
    await click(inDialog('Group'));
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (option) => option.textContent,
    );
    // Biology already has access.
    expect(options).toEqual(['Chemistry']);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')][0]!);
    await click(inDialog('Share project'));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/projects/p1/shares', {
      subject: { type: 'group', groupId: 'g2' },
      permission: 'viewer',
    });
  });

  it('says there are no groups to choose from when the person is in none', async () => {
    groups = [];
    await open();
    await click(radio('A group'));
    expect(dialog()!.textContent).toContain('You are not in any groups.');
    expect(inDialog('Share project').disabled).toBe(true);
  });

  it('keeps the address and explains an unknown person, without more than the server said', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'No account has that email address.', {
        reason: 'person_not_found',
      }),
    );
    await open();
    await typeInto(emailField(), 'nobody@example.test');
    await click(inDialog('Share project'));
    expect(alerts(dialog()!).join(' ')).toContain(
      'No account has that email address. It has to match exactly.',
    );
    expect(emailField().value).toBe('nobody@example.test');
  });

  it('tells how long to wait after too many attempts (429, Retry-After)', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(
      new ApiError(429, 'RATE_LIMITED', 'Too many requests', undefined, 20),
    );
    await open();
    await typeInto(emailField(), 'dana@example.test');
    await click(inDialog('Share project'));
    expect(alerts(dialog()!).join(' ')).toContain(
      'Too many sharing attempts. Try again in 20 seconds.',
    );
  });

  it('says an upgrade is in progress when the server does (409)', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(
      new ApiError(
        409,
        'CONFLICT',
        'An upgrade is still in progress. Try again when it has finished.',
        {
          reason: 'upgrade_in_progress',
        },
      ),
    );
    await open();
    await typeInto(emailField(), 'dana@example.test');
    await click(inDialog('Share project'));
    expect(alerts(dialog()!).join(' ')).toContain(
      'An upgrade is still in progress. Try again when it has finished.',
    );
  });

  it.each([
    [
      'the share limit',
      422,
      'share_limit',
      'A project can be shared with at most 50 people or groups.',
    ],
    [
      'the other person’s limit',
      422,
      'inbound_limit',
      'That person already has 100 projects shared with them.',
    ],
    [
      'sharing with yourself',
      422,
      'cannot_share_with_self',
      'You cannot share a project with yourself.',
    ],
  ])('shows the server’s sentence for %s', async (_name, status, reason, message) => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.post.mockRejectedValue(new ApiError(status, 'VALIDATION_FAILED', message, { reason }));
    await open();
    await typeInto(emailField(), 'dana@example.test');
    await click(inDialog('Share project'));
    expect(alerts(dialog()!).join(' ')).toContain(message);
  });

  it('changes a level and says so', async () => {
    await open();
    await choose('Editor', 'Access for Vera Viewer');
    expect(api.patch).toHaveBeenCalledExactlyOnceWith('/projects/p1/shares/share-1', {
      permission: 'editor',
    });
  });

  it('stops sharing and says what became of their conversations and files', async () => {
    await open();
    await click(inDialog('Stop sharing with Vera Viewer'));
    expect(api.delete).toHaveBeenCalledExactlyOnceWith('/projects/p1/shares/share-1');
    const status = dialog()!.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('Stopped sharing with Vera Viewer.');
    expect(status).toContain('Their 3 conversations were kept and left the project.');
    expect(status).toContain('1 file they added now belongs to you.');
  });

  it('is off while the instance is read-only, with the reason', async () => {
    const { setReadOnlyStatus } = await import('../../src/lib/read-only');
    const { INACTIVE_READ_ONLY_STATUS } = await import('@oci/shared');
    setReadOnlyStatus({ ...INACTIVE_READ_ONLY_STATUS, active: true, source: 'administrator' });
    try {
      await open();
      await typeInto(emailField(), 'dana@example.test');
      expectLocked(inDialog('Share project'), 'Read-only for maintenance');
      expect(findButton('Stop sharing with Vera Viewer')).toBeDefined();
      expectLocked(inDialog('Stop sharing with Vera Viewer'), 'Read-only for maintenance');
    } finally {
      setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS);
    }
  });
});

// @vitest-environment happy-dom
import type { MyShareLink, MyShareLinksResponse } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSharingPage } from '../../src/routes/settings/sharing';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  expectLocked,
  findButton,
  renderAdmin,
} from './admin-test-utils';
import { untitledTruncations } from './truncation';

/**
 * Settings → Sharing (v0.10): every share link the person made, with their
 * conversation, live or snapshot, dates and views, and Revoke and Revoke all
 * behind a confirmation. Listed even when sharing is off for them.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const SLUG = 'A'.repeat(32);
const HOUR = 3_600_000;

function link(id: string, extra: Partial<MyShareLink> = {}): MyShareLink {
  return {
    id,
    slug: `${id}${'x'.repeat(32 - id.length)}`,
    path: `/share/${id}`,
    threadId: `thread-${id}`,
    threadTitle: `Conversation ${id}`,
    threadUnavailable: false,
    upToMessageId: null,
    viewCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - HOUR).toISOString(),
    ...extra,
  };
}

let pages: MyShareLinksResponse[];
let features: Record<string, boolean>;
let root: Root | undefined;

beforeEach(() => {
  features = { shareLinks: true };
  pages = [
    {
      links: [
        link('live', { slug: SLUG, viewCount: 1 }),
        link('snap', {
          upToMessageId: 'message-1',
          viewCount: 4,
          expiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        }),
        link('old', { expiresAt: new Date(Date.now() - HOUR).toISOString() }),
        link('gone', { revokedAt: new Date().toISOString() }),
        link('binned', { threadUnavailable: true, threadTitle: 'Binned chat' }),
      ],
      total: 5,
      active: 4,
      nextOffset: null,
    },
  ];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return { user: { id: 'u1', name: 'Pat', email: 'pat@example.test' }, features };
    if (path === '/me/share-links') return pages[0];
    if (path === '/me/share-links?offset=5') return pages[1];
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset().mockResolvedValue({ revoked: 4 });
  api.delete.mockReset().mockResolvedValue({ link: {} });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsSharingPage />, { path: '/settings/sharing' }));
};

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="share-link"]')];
}

function row(title: string): HTMLElement {
  const match = rows().find((candidate) => candidate.textContent?.includes(title));
  if (!match) throw new Error(`No row for ${title}`);
  return match;
}

describe('Settings → Sharing', () => {
  it('lists every link with its conversation, kind, status, dates and views', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Sharing');
    expect(rows()).toHaveLength(5);

    const live = row('Conversation live');
    expect(live.querySelector('a')?.getAttribute('href')).toBe('/chat/thread-live');
    expect(live.textContent).toContain('Active');
    expect(live.textContent).toContain('Live');
    expect(live.textContent).toContain('No expiration');
    expect(live.textContent).toContain('1 view');

    const snapshot = row('Conversation snap');
    expect(snapshot.textContent).toContain('Snapshot');
    expect(snapshot.textContent).toContain('Expires ');
    expect(snapshot.textContent).toContain('4 views');

    expect(row('Conversation old').textContent).toContain('Expired');
    // Expired: nothing to copy, but it can still be revoked.
    expect(findButton('Copy the link to Conversation old')).toBeUndefined();
    expect(findButton('Revoke the link to Conversation old')).toBeDefined();

    const revoked = row('Conversation gone');
    expect(revoked.textContent).toContain('Revoked');
    expect(revoked.querySelector('button')).toBeNull();

    const binned = row('Binned chat');
    expect(binned.querySelector('a')).toBeNull();
    expect(binned.textContent).toContain('in the trash or expired');

    // Not "4 of 5 not revoked" (#254).
    expect(document.body.textContent).toContain('5 links · 1 revoked');
    expect(document.body.textContent).not.toContain('turned off for your account');
  });

  it('gives every conversation title a tooltip, as it can be cut short (#130)', async () => {
    await render();
    expect(document.querySelectorAll('[data-testid="share-link"]').length).toBeGreaterThan(0);
    expect(untitledTruncations()).toEqual([]);
  });

  it('revokes one link after confirming', async () => {
    await render();
    await click(button('Revoke the link to Conversation snap'));
    expect(dialog()?.textContent).toContain('Revoke this link?');
    expect(dialog()?.textContent).toContain(
      'The link to “Conversation snap” stops working at once',
    );
    expect(api.delete).not.toHaveBeenCalled();

    await click(button('Revoke link'));
    expect(api.delete).toHaveBeenCalledWith('/share-links/links/snap');
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain('The link has been revoked.');
    // The list is read again.
    expect(
      api.get.mock.calls.filter(([path]) => path === '/me/share-links').length,
    ).toBeGreaterThan(1);
  });

  it('revokes all links after confirming, and can be cancelled', async () => {
    await render();
    await click(button('Revoke all'));
    expect(dialog()?.textContent).toContain('Revoke all 4 share links?');
    await click(button('Cancel'));
    expect(api.post).not.toHaveBeenCalled();

    await click(button('Revoke all'));
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Revoke all',
    )!;
    await click(confirm);
    expect(api.post).toHaveBeenCalledWith('/me/share-links/revoke-all');
    expect(document.body.textContent).toContain('4 links have been revoked.');
  });

  it('shows the server’s reason when revoking fails, and keeps the dialog open', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.delete.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Share link not found'));
    await render();
    await click(button('Revoke the link to Conversation live'));
    await click(button('Revoke link'));
    expect(alerts()).toContain('The link could not be revoked. Share link not found');
    expect(dialog()).not.toBeNull();
  });

  it('copies an active link', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await click(button('Copy the link to Conversation live'));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/share/${SLUG}`);
    expect(row('Conversation live').textContent).toContain('Copied');
  });

  it('still lists links, and offers revoking them, while sharing is off for the person', async () => {
    features = { shareLinks: false };
    await render();
    expect(document.querySelector('[role="note"]')?.textContent).toContain(
      'Making new share links is turned off for your account',
    );
    expect(rows()).toHaveLength(5);
    expect(button('Revoke all').disabled).toBe(false);
  });

  it('pages through many links', async () => {
    pages[0] = { ...pages[0]!, total: 6, nextOffset: 5 };
    pages[1] = { links: [link('sixth')], total: 6, active: 4, nextOffset: null };
    await render();
    expect(rows()).toHaveLength(5);
    await click(button('Show more'));
    expect(rows()).toHaveLength(6);
    expect(findButton('Show more')).toBeUndefined();
  });

  it('says when there is nothing shared, with nothing to revoke', async () => {
    pages[0] = { links: [], total: 0, active: 0, nextOffset: null };
    await render();
    expect(document.body.textContent).toContain('You have not shared any conversations.');
    expect(findButton('Revoke all')).toBeUndefined();
  });

  it('does not explain how to share to someone who may not (#99)', async () => {
    features = { shareLinks: false };
    pages[0] = { links: [], total: 0, active: 0, nextOffset: null };
    await render();
    expect(document.body.textContent).toContain('You have no share links.');
    expect(document.body.textContent).not.toContain('To share one');
  });

  it('reports a list that could not be loaded', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/me') return { user: { id: 'u1' }, features };
      throw new Error('offline');
    });
    await render();
    expect(alerts().join(' ')).toContain('could not be loaded');
  });

  it('turns Revoke and Revoke all off with the reason while read-only (#331)', async () => {
    const { setReadOnlyStatus } = await import('../../src/lib/read-only');
    const { INACTIVE_READ_ONLY_STATUS } = await import('@oci/shared');
    setReadOnlyStatus({ ...INACTIVE_READ_ONLY_STATUS, active: true, source: 'administrator' });
    try {
      await render();
      for (const name of ['Revoke the link to Conversation snap', 'Revoke all']) {
        expectLocked(button(name), 'Read-only for maintenance', name);
      }
      // Copying a link is reading, and stays on.
      expect(findButton('Copy')?.disabled).toBe(false);
    } finally {
      setReadOnlyStatus(INACTIVE_READ_ONLY_STATUS);
    }
  });
});

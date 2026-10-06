// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShareThreadDialog } from '../../src/components/chat/share-thread-dialog';
import { button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';
import { untitledTruncations } from './truncation';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it('shows the whole share link as a tooltip, as the dialog cuts it short (#130)', async () => {
  const slug = 'A'.repeat(32);
  api.get.mockImplementation(async (path: string) =>
    path.startsWith('/share-links/')
      ? {
          links: [
            {
              id: 'l1',
              slug,
              path: `/share/${slug}`,
              upToMessageId: null,
              viewCount: 2,
              expiresAt: null,
              revokedAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : { messages: [] },
  );
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  expect(dialog()?.textContent).toContain(`/share/${slug}`);
  expect(untitledTruncations()).toEqual([]);
});

it('asks before revoking a link, as Settings → Sharing does (#252)', async () => {
  const slug = 'B'.repeat(32);
  let revokedAt: string | null = null;
  api.get.mockImplementation(async (path: string) =>
    path.startsWith('/share-links/')
      ? {
          links: [
            {
              id: 'l1',
              slug,
              path: `/share/${slug}`,
              upToMessageId: null,
              viewCount: 0,
              expiresAt: null,
              revokedAt,
              createdAt: new Date().toISOString(),
            },
          ],
        }
      : { messages: [] },
  );
  api.delete.mockImplementation(async () => {
    revokedAt = new Date().toISOString();
    return {};
  });
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));

  // The first click only asks; Cancel leaves the link working.
  await click(button('Revoke share link'));
  expect(api.delete).not.toHaveBeenCalled();
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
  expect(dialogs().at(-1)?.textContent).toContain('Revoke this link?');
  expect(dialogs().at(-1)?.textContent).toContain('A revoked link cannot be turned back on');
  await click(button('Cancel'));
  expect(api.delete).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain('active');

  // Confirmed, it is revoked, and the share dialog stays open showing so.
  await click(button('Revoke share link'));
  await click(button('Revoke link'));
  expect(api.delete).toHaveBeenCalledExactlyOnceWith('/share-links/links/l1');
  expect(dialogs()).toHaveLength(1);
  expect(dialog()?.textContent).toContain('revoked');
  expect(button('Revoke share link').disabled).toBe(true);
});

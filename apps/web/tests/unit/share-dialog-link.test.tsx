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

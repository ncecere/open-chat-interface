// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ShareThreadDialog } from '../../src/components/chat/share-thread-dialog';
import { ApiError } from '../../src/lib/api-client';
import { alerts, button, cleanup, click, dialog, renderAdmin } from './admin-test-utils';

/** A share link of a conversation that carries a data class (v0.14, #395). */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
const slug = 'C'.repeat(32);
const link = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  slug,
  path: `/share/${slug}`,
  upToMessageId: null,
  viewCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** The status badge of the first listed link. */
const badge = () => dialog()?.querySelector('li span')?.textContent;

const serve = (links: unknown[]) =>
  api.get.mockImplementation(async (path: string) =>
    path.startsWith('/share-links/') ? { links } : { messages: [] },
  );

it('marks a link paused while the conversation carries a class, and does not offer to copy it', async () => {
  serve([link({ paused: true })]);
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  expect(badge()).toBe('paused');
  expect(dialog()?.textContent).toContain(
    'Paused: this conversation carries a data class, so the link shows nothing for now. It works again if the label is removed.',
  );
  expect(button('Copy share link').disabled).toBe(true);
});

it('shows a link as active when it is not paused', async () => {
  serve([link()]);
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  expect(badge()).toBe('active');
  expect(dialog()?.querySelector('[data-share-paused]')).toBeNull();
  expect(button('Copy share link').disabled).toBe(false);
});

it('does not call a revoked or expired link paused', async () => {
  serve([link({ paused: true, revokedAt: new Date().toISOString() })]);
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  expect(badge()).toBe('revoked');
  expect(dialog()?.querySelector('[data-share-paused]')).toBeNull();
});

it('tells the owner, after a link is made in warn, what the conversation carries', async () => {
  serve([]);
  api.post.mockResolvedValue({
    link: link(),
    notice: 'This conversation carries Student records, and anyone with the link can read it.',
  });
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  await click(button('Create and copy link'));
  const notice = dialog()?.querySelector('[data-share-notice]');
  expect(notice?.getAttribute('role')).toBe('status');
  expect(notice?.textContent).toBe(
    'This conversation carries Student records, and anyone with the link can read it.',
  );
  // Making another link starts from a clean notice.
  api.post.mockResolvedValue({ link: link() });
  await click(button('Create and copy link'));
  expect(dialog()?.querySelector('[data-share-notice]')).toBeNull();
});

it('shows the refusal in block, as the server words it', async () => {
  serve([]);
  const refusal =
    'This conversation cannot be shared. It carries Student records, and a share link is open to anyone who has it.';
  api.post.mockRejectedValue(new ApiError(403, 'DATA_CLASS_BLOCKED', refusal));
  ({ root } = await renderAdmin(<ShareThreadDialog threadId="t1" />));
  await click(button('Share conversation'));
  await click(button('Create and copy link'));
  expect(alerts(dialog()!)).toEqual([refusal]);
});

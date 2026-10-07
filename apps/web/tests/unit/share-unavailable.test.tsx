// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationLoadError } from '../../src/components/chat/conversation-load-error';
import { ApiError } from '../../src/lib/api-client';
import { PublicSharePage } from '../../src/routes/share/public-share';
import { cleanup, renderAdmin } from './admin-test-utils';

/**
 * #131 (regression of #113): a missing, expired or revoked share is shown in
 * the layout of every other unavailable page, and offers a way on.
 */
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** The structure of a page's unavailable state: heading, reason, actions. */
function shape(scope: ParentNode) {
  const heading = scope.querySelector('h1');
  const section = heading?.closest('section');
  return {
    heading: heading?.textContent,
    wrapper: section?.parentElement?.className.split(' ').slice(0, 4).join(' '),
    section: section?.className,
    links: [...(section?.querySelectorAll('a') ?? [])].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ]),
  };
}

it.each([
  [404, null, 'Shared conversation not found'],
  [410, 'expired', 'This share link has expired'],
  [410, 'revoked', 'This share link was revoked'],
])('a %s (%s) share has a way back, in the shared layout', async (status, reason, title) => {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/share-links/'))
      throw new ApiError(status, 'unavailable', 'Unavailable', reason ? { reason } : undefined);
    return { branding: { appName: 'Campus Chat' } };
  });
  ({ root } = await renderAdmin(<PublicSharePage slug="missing" />));
  const share = shape(document);
  expect(share.heading).toBe(title);
  expect(share.links).toEqual([['Go to Campus Chat', '/']]);
  expect(document.querySelector('main')).not.toBeNull();

  // The same layout as a missing conversation in the chat shell.
  await cleanup(root);
  ({ root } = await renderAdmin(<ConversationLoadError unavailable retry={() => undefined} />));
  const conversation = shape(document);
  expect(share.wrapper).toBe(conversation.wrapper);
  expect(share.section).toBe(conversation.section);
});

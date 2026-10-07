// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { ConversationLoadError } from '../../src/components/chat/conversation-load-error';
import { cleanup, renderAdmin } from './admin-test-utils';
import { shownTitle, TitleProbe } from './title-probe';

/**
 * #197: a conversation that cannot be shown left the tab as the app's name
 * alone, the same as the chat home. The page that says so names the tab.
 */
let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it.each([
  [true, 'Conversation unavailable · Acme'],
  [false, 'Could not load conversation · Acme'],
])(
  'names the tab for a conversation that cannot be shown (unavailable: %s)',
  async (unavailable, title) => {
    ({ root } = await renderAdmin(
      <>
        <ConversationLoadError unavailable={unavailable} retry={() => undefined} />
        <TitleProbe />
      </>,
      { path: '/chat/missing' },
    ));
    expect(shownTitle()).toBe(title);
  },
);

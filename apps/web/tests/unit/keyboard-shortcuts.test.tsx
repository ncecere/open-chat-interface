// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import { AppShell } from '../../src/components/layout/app-shell';
import { useGlobalShortcuts } from '../../src/hooks/use-global-shortcuts';
import { ariaKeyShortcuts, matchShortcut, shortcutKeys } from '../../src/lib/keyboard-shortcuts';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { cleanup, renderAdmin, settle } from './admin-test-utils';

/**
 * ⌘K, ⌘⇧O, ⌘B and ⌘/ (Ctrl elsewhere), as listed in Settings → Keyboard
 * Shortcuts. Only ⌘K used to do anything.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/composer-connect-hint', () => ({
  ComposerConnectHint: () => null,
}));

const model = {
  id: 'm',
  slug: 'm',
  displayName: 'Model',
  description: null,
  providerId: 'p',
  providerKind: 'openai-compatible',
  providerLabel: 'P',
  upstreamModelId: 'm',
  capabilities: [],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
} as unknown as CatalogModel;

let root: Root | undefined;
let platform: string;

beforeEach(() => {
  platform = 'Linux x86_64';
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform });
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') {
      return {
        user: { id: 'me', name: 'Pat', email: 'pat@example.test', role: 'user' },
        preferences: {},
        features: { temporaryChat: true, projects: false, shareLinks: false },
      };
    }
    if (path === '/auth/status') return { branding: {} };
    if (path === '/threads?view=sidebar') return { threads: [] };
    if (path === '/projects/sidebar') return { projects: [] };
    if (path === '/me/broadcasts') return { broadcasts: [] };
    if (path === '/me/usage') return { allowances: [] };
    throw new Error(`Unexpected GET ${path}`);
  });
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

function keydown(
  target: EventTarget,
  init: KeyboardEventInit,
  { keyCode }: { keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const press = (key: string, extra: KeyboardEventInit = {}) => ({
  key,
  ctrlKey: true,
  ...extra,
});

describe('matchShortcut', () => {
  const event = (init: Partial<KeyboardEvent>) =>
    ({
      key: '',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      keyCode: 0,
      ...init,
    }) as KeyboardEvent;

  it('uses Command on Apple platforms and Ctrl elsewhere', () => {
    expect(matchShortcut(event({ key: 'b', metaKey: true }), true)).toBe('toggle-sidebar');
    expect(matchShortcut(event({ key: 'b', ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(event({ key: 'b', ctrlKey: true }), false)).toBe('toggle-sidebar');
    expect(matchShortcut(event({ key: 'b', metaKey: true }), false)).toBeNull();
  });

  it('knows each shortcut and nothing else', () => {
    expect(matchShortcut(event({ key: 'O', shiftKey: true, ctrlKey: true }), false)).toBe(
      'new-chat',
    );
    expect(matchShortcut(event({ key: 'o', ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(event({ key: '/', ctrlKey: true }), false)).toBe('model-picker');
    // "/" needs Shift on some layouts.
    expect(matchShortcut(event({ key: '/', ctrlKey: true, shiftKey: true }), false)).toBe(
      'model-picker',
    );
    expect(matchShortcut(event({ key: 'B', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(event({ key: 'b', ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(event({ key: 'k', ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(event({ key: 'b' }), false)).toBeNull();
  });

  it('ignores input method composition and auto-repeat', () => {
    expect(matchShortcut(event({ key: 'b', ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut(event({ key: 'b', ctrlKey: true, keyCode: 229 }), false)).toBeNull();
    expect(matchShortcut(event({ key: 'b', ctrlKey: true, repeat: true }), false)).toBeNull();
  });

  it('describes the keys for display and for assistive technology', () => {
    expect(shortcutKeys('new-chat', true)).toEqual(['⌘', '⇧', 'O']);
    expect(shortcutKeys('new-chat', false)).toEqual(['Ctrl', 'Shift', 'O']);
    expect(shortcutKeys('model-picker', true)).toEqual(['⌘', '/']);
    expect(ariaKeyShortcuts('new-chat', true)).toBe('Meta+Shift+O');
    expect(ariaKeyShortcuts('toggle-sidebar', false)).toBe('Control+B');
  });
});

describe('in the composer', () => {
  function Shortcuts(props: { onNewChat: () => void; onToggleSidebar: () => void }) {
    useGlobalShortcuts(props);
    return null;
  }

  async function render(withComposer = true) {
    const onNewChat = vi.fn();
    const onToggleSidebar = vi.fn();
    ({ root } = await renderAdmin(
      <ThemeProvider>
        <Shortcuts onNewChat={onNewChat} onToggleSidebar={onToggleSidebar} />
        {withComposer && (
          <Composer
            value="Draft"
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            models={[model]}
            selectedModel={model}
            onSelectModel={vi.fn()}
            effort="instant"
            onEffortChange={vi.fn()}
            webSearch={false}
            onWebSearchChange={vi.fn()}
            onAttachFiles={vi.fn()}
          />
        )}
        <input aria-label="Elsewhere" />
      </ThemeProvider>,
    ));
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message input"]',
    );
    textarea?.focus();
    return { onNewChat, onToggleSidebar, textarea };
  }

  it('starts a new chat and toggles the sidebar while typing, without the browser default', async () => {
    const { onNewChat, onToggleSidebar, textarea } = await render();

    const newChat = keydown(textarea!, press('O', { shiftKey: true }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(newChat.defaultPrevented).toBe(true);

    const toggle = keydown(textarea!, press('b'));
    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(toggle.defaultPrevented).toBe(true);
  });

  it('does nothing while an input method is composing', async () => {
    const { onNewChat, onToggleSidebar, textarea } = await render();

    const composing = keydown(textarea!, press('b', { isComposing: true }));
    keydown(textarea!, press('O', { shiftKey: true }), { keyCode: 229 });
    expect(onToggleSidebar).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
  });

  it('opens the model picker with its search focused', async () => {
    const { textarea } = await render();
    const trigger = document.querySelector('[aria-label^="Select model"]');
    expect(trigger?.getAttribute('aria-keyshortcuts')).toBe('Control+/');
    expect(document.querySelector('[aria-label="Choose a model"]')).toBeNull();

    const open = keydown(textarea!, press('/'));
    await settle();
    expect(open.defaultPrevented).toBe(true);
    expect(document.querySelector('[aria-label="Choose a model"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search models');
  });

  it('leaves Ctrl+/ alone on a page without a composer', async () => {
    await render(false);
    const elsewhere = document.querySelector<HTMLInputElement>('[aria-label="Elsewhere"]')!;
    elsewhere.focus();
    const event = keydown(elsewhere, press('/'));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('in the app shell', () => {
  async function render(path = '/chat/thread-1') {
    let router: Awaited<ReturnType<typeof renderAdmin>>['router'];
    ({ root, router } = await renderAdmin(
      <ThemeProvider>
        <AppShell>
          <p>Page</p>
        </AppShell>
      </ThemeProvider>,
      { path },
    ));
    return router;
  }
  const sidebar = () => document.querySelector('aside');

  it('toggles the sidebar and announces the shortcut on both toggle buttons', async () => {
    await render();
    expect(sidebar()?.getAttribute('aria-hidden')).toBeNull();
    expect(
      document.querySelector('[aria-label="Close sidebar"]')?.getAttribute('aria-keyshortcuts'),
    ).toBe('Control+B');

    keydown(document.body, press('b'));
    await settle();
    expect(sidebar()?.getAttribute('aria-hidden')).toBe('true');
    expect(
      document.querySelector('[aria-label="Open sidebar"]')?.getAttribute('aria-keyshortcuts'),
    ).toBe('Control+B');
    expect(
      document.querySelector('[aria-label="New chat"]')?.getAttribute('aria-keyshortcuts'),
    ).toBe('Control+Shift+O');

    keydown(document.body, press('b'));
    await settle();
    expect(sidebar()?.getAttribute('aria-hidden')).toBeNull();
  });

  it('starts a new chat from a conversation', async () => {
    const router = await render('/chat/thread-1');
    const newChat = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'New Chat',
    );
    expect(newChat?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+O');

    keydown(document.body, press('O', { shiftKey: true }));
    await settle();
    expect(router.state.location.pathname).toBe('/');
  });

  it('shows the same shortcuts in the command palette, in the platform modifier', async () => {
    platform = 'MacIntel';
    await render('/');
    keydown(document.body, { key: 'k', metaKey: true });
    await settle();

    const option = (label: string) =>
      [...document.querySelectorAll('[role="option"]')].find((node) =>
        node.textContent?.startsWith(label),
      );
    const keys = (label: string) =>
      [...(option(label)?.querySelectorAll('kbd') ?? [])].map((kbd) => kbd.textContent);
    expect(keys('New chat')).toEqual(['⌘', '⇧', 'O']);
    expect(keys('Close sidebar')).toEqual(['⌘', 'B']);
  });
});

// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TemporaryChatProvider } from '../../src/providers/temporary-chat-provider';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { ChatHomePage } from '../../src/routes/chat/home';
import { cleanup, renderAdmin, settle } from './admin-test-utils';

/**
 * #156: while /api/models (and /api/me) are pending, home says nothing about
 * the models. It said "No models are available yet…" and the composer "No
 * models available" for as long as the request took. Real query cache and
 * hooks; the server answers when the test says so.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const MODEL = {
  id: 'm1',
  slug: 'alpha',
  displayName: 'Alpha',
  description: null,
  providerId: 'p1',
  providerKind: 'openai-compatible',
  providerLabel: 'Gateway',
  upstreamModelId: 'alpha',
  capabilities: [],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};
const ME = {
  user: { id: 'u1', name: 'Owen Fitzgerald', email: 'o@example.test', role: 'user' },
  preferences: {},
  features: { attachments: true, webSearch: false, projects: true },
};

let answer: Record<string, (value: unknown) => void>;
let root: Root | undefined;
beforeEach(() => {
  answer = {};
  api.get.mockReset().mockImplementation(
    (path: string) =>
      new Promise((resolve) => {
        answer[path] = resolve;
      }),
  );
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function render() {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <TemporaryChatProvider>
        <ChatHomePage />
      </TemporaryChatProvider>
    </ThemeProvider>,
  ));
}

async function respond(path: string, value: unknown) {
  answer[path]?.(value);
  await settle();
}

const text = () => document.body.textContent ?? '';
const attach = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Attach"]') ?? null;

it('says nothing about models, and keeps the greeting and Attach in place, while loading', async () => {
  await render();
  expect(text()).not.toContain('No models are available yet');
  expect(text()).not.toContain('No models available');
  expect(text()).toContain('Loading models…');
  // Attach waits rather than appearing later; the greeting keeps room for the name.
  expect(attach()?.disabled).toBe(true);
  const greeting = document.querySelector('h1 > span')!;
  expect(greeting.className).toContain('invisible');
  expect(greeting.querySelector('span')).not.toBeNull();

  await respond('/me', ME);
  await respond('/models', { models: [MODEL] });
  expect(document.querySelector('h1')?.textContent).toBe('How can I help you, Owen?');
  expect(document.querySelector('h1 > span')?.className ?? '').not.toContain('invisible');
  expect(attach()?.disabled).toBe(false);
  expect(text()).not.toContain('No models');
});

it('still says so when the instance really has no models', async () => {
  await render();
  await respond('/me', ME);
  await respond('/models', { models: [] });
  expect(text()).toContain('No models are available yet');
  expect(text()).toContain('No models available');
});

// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Composer } from '../../src/components/chat/composer';
import { ChatHomePage } from '../../src/routes/chat/home';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  models: [
    {
      slug: 'model',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
  file: {
    id: 'file',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    url: '/api/attachments/file/content',
  },
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../src/hooks/use-models', () => ({
  useModels: () => ({ data: mocks.models }),
  useModelsHiddenFromRole: () => false,
}));
const me = vi.hoisted(() => ({
  name: 'Priya Walk',
  displayName: null as string | null,
}));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({
    data: {
      user: { name: me.name },
      preferences: { displayName: me.displayName },
      features: { webSearch: false },
    },
  }),
}));
vi.mock('../../src/hooks/use-threads', () => ({
  useCreateThread: () => ({ mutateAsync: mocks.create }),
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false }),
}));
vi.mock('../../src/hooks/use-attachments', () => ({
  useAttachments: () => ({
    items: [{ localId: 'local', status: 'ready', attachment: mocks.file }],
    upload: vi.fn(),
    remove: vi.fn(),
    handOver: vi.fn(),
  }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: ComponentProps<typeof Composer>) => {
    mocks.composer = props;
    return null;
  },
}));
it('greets by name with one space, and says the name once (#94)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() => root.render(<ChatHomePage />));
  const heading = container.querySelector('h1')!;
  // textContent is what a screen reader reads: no doubled name, no run-on.
  expect(heading.textContent).toBe('How can I help you, Priya?');
  // The flex gap is for the temporary-chat icon; the greeting is one item.
  expect(heading.children).toHaveLength(1);
  await act(() => root.unmount());
});

async function greeting() {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(() => root.render(<ChatHomePage />));
  const text = container.querySelector('h1')!.textContent;
  await act(() => root.unmount());
  return text;
}

it('greets by the name the introduction asked for, else the given name (#315)', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // "What should we call you?" answered "Newt" on an account named Walk7 Newcomer.
  Object.assign(me, { name: 'Walk7 Newcomer', displayName: ' Newt ' });
  expect(await greeting()).toBe('How can I help you, Newt?');
  // No answer: the account's given name, not a family name or a title.
  Object.assign(me, { name: 'Weber, Jonas', displayName: '' });
  expect(await greeting()).toBe('How can I help you, Jonas?');
  Object.assign(me, { name: 'Dr. Jane Doe', displayName: null });
  expect(await greeting()).toBe('How can I help you, Jane?');
  Object.assign(me, { name: '', displayName: null });
  expect(await greeting()).toBe('How can I help you?');
  Object.assign(me, { name: 'Priya Walk', displayName: null });
});

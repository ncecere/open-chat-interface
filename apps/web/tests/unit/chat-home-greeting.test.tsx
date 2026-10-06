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
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: mocks.models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({
    data: { user: { name: 'Priya Walk' }, features: { webSearch: false } },
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

// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  useCurrentUser: () => ({ data: undefined }),
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
  }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: ComponentProps<typeof Composer>) => {
    mocks.composer = props;
    return null;
  },
}));
let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ thread: { id: 'destination' } });
  mocks.navigate.mockReset();
  mocks.navigate.mockResolvedValue(undefined);
  root = createRoot(document.createElement('div'));
  await act(() => root.render(<ChatHomePage />));
  await act(() => mocks.composer!.onChange('Question'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
});

it('scopes the complete prompt/upload handover before navigating to its new thread', async () => {
  sessionStorage.setItem('oci.pendingThreadId', 'previous');
  mocks.navigate.mockImplementation(async () => {
    expect(sessionStorage.getItem('oci.pendingThreadId')).toBe('destination');
    expect(sessionStorage.getItem('oci.pendingPrompt')).toBe('Question');
    expect(JSON.parse(sessionStorage.getItem('oci.pendingAttachments')!)).toEqual([mocks.file]);
  });
  await act(() => mocks.composer!.onSubmit());
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ temporary: false });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    to: '/chat/$threadId',
    params: { threadId: 'destination' },
  });
});

it('invalidates the old destination before a partial session-storage write can fail', async () => {
  sessionStorage.setItem('oci.pendingThreadId', 'previous');
  const original = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, 'setItem').mockImplementation((key, value) => {
    if (key === 'oci.pendingAttachments')
      throw new DOMException('Storage full', 'QuotaExceededError');
    original(key, value);
  });
  await act(async () => {
    await expect(mocks.composer!.onSubmit()).rejects.toThrow('Storage full');
  });
  expect(sessionStorage.getItem('oci.pendingThreadId')).toBeNull();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.composer?.value).toBe('Question');
});

it('keeps the draft and previous handover untouched when thread creation fails', async () => {
  sessionStorage.setItem('oci.pendingThreadId', 'previous');
  sessionStorage.setItem('oci.pendingPrompt', 'Previous question');
  mocks.create.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => {
    await expect(mocks.composer!.onSubmit()).rejects.toThrow('Unavailable');
  });
  expect(sessionStorage.getItem('oci.pendingThreadId')).toBe('previous');
  expect(sessionStorage.getItem('oci.pendingPrompt')).toBe('Previous question');
  expect(mocks.composer?.value).toBe('Question');
  expect(mocks.navigate).not.toHaveBeenCalled();
});

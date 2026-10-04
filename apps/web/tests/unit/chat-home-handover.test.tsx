// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Composer } from '../../src/components/chat/composer';
import { ApiError } from '../../src/lib/api-client';
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
let container: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ thread: { id: 'destination' } });
  mocks.navigate.mockReset();
  mocks.navigate.mockResolvedValue(undefined);
  container = document.createElement('div');
  root = createRoot(container);
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

it('creates one conversation however often it is submitted while creating it', async () => {
  // The v0.10.1 incident: every send key that reached the home composer before
  // the navigation committed was another POST /api/threads.
  let finish!: (value: { thread: { id: string } }) => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = mocks.composer!.onSubmit() as unknown as Promise<void>;
  await act(async () => {});
  expect(mocks.composer?.submitting).toBe(true);
  for (let press = 0; press < 50; press += 1) {
    await act(async () => {
      await mocks.composer!.onSubmit();
    });
  }
  // A suggested prompt is guarded by the same flag.
  const suggestion = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'How does AI work?',
  );
  await act(async () => suggestion?.click());
  expect(mocks.create).toHaveBeenCalledOnce();

  await act(async () => {
    finish({ thread: { id: 'destination' } });
    await first;
  });
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    to: '/chat/$threadId',
    params: { threadId: 'destination' },
  });
});

it('stays guarded after handing over, until the draft is edited', async () => {
  await act(() => mocks.composer!.onSubmit());
  // Navigation resolved but this page is still shown (the route change has not
  // rendered yet, or another navigation replaced it): the prompt already
  // belongs to the conversation just created.
  await act(() => mocks.composer!.onSubmit());
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledOnce();
  expect(mocks.composer?.submitting).toBe(true);

  // Editing is a deliberate new message.
  await act(() => mocks.composer!.onChange('Another question'));
  expect(mocks.composer?.submitting).toBe(false);
  await act(() => mocks.composer!.onSubmit());
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it('allows another try after a failed creation', async () => {
  mocks.create.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => {
    await expect(mocks.composer!.onSubmit()).rejects.toThrow('Unavailable');
  });
  expect(mocks.composer?.submitting).toBe(false);
  await act(() => mocks.composer!.onSubmit());
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.navigate).toHaveBeenCalledOnce();
});

it('says why when the server refuses to start a conversation', async () => {
  mocks.create.mockRejectedValueOnce(
    new ApiError(
      429,
      'RATE_LIMITED',
      'You are starting conversations too quickly. Try again in a moment.',
    ),
  );
  await act(async () => {
    await expect(mocks.composer!.onSubmit()).rejects.toThrow('too quickly');
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'You are starting conversations too quickly. Try again in a moment.',
  );
  // The next attempt clears it.
  await act(() => mocks.composer!.onSubmit());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('allows another try when the navigation itself fails', async () => {
  mocks.navigate.mockRejectedValueOnce(new Error('Route failed'));
  await act(async () => {
    await expect(mocks.composer!.onSubmit()).rejects.toThrow('Route failed');
  });
  expect(mocks.composer?.submitting).toBe(false);
  await act(() => mocks.composer!.onSubmit());
  expect(mocks.create).toHaveBeenCalledTimes(2);
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

// @vitest-environment happy-dom
import type { ClassificationResponse } from '@oci/shared';
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Composer } from '../../src/components/chat/composer';
import { ChatHomePage } from '../../src/routes/chat/home';

/** A new chat in a labelled project starts on a model approved for its labels (v0.14, #395). */
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  classification: undefined as ClassificationResponse | undefined,
  asked: [] as unknown[][],
  models: [
    {
      slug: 'plain',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
    {
      slug: 'approved',
      isDefault: false,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    mocks.asked.push(options.queryKey);
    return options.queryKey[0] === 'classification'
      ? { data: mocks.classification }
      : { data: undefined, isError: false };
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: () => null,
}));
vi.mock('../../src/hooks/use-models', () => ({
  useModels: () => ({ data: mocks.models, isSuccess: true, isPending: false, isError: false }),
  useModelsHiddenFromRole: () => false,
}));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({
    data: { user: { name: 'Priya' }, preferences: {}, features: { webSearch: false } },
  }),
}));
vi.mock('../../src/hooks/use-threads', () => ({
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false, setTemporary: vi.fn() }),
}));
vi.mock('../../src/hooks/use-attachments', () => ({
  useAttachments: () => ({ items: [], upload: vi.fn(), remove: vi.fn(), handOver: vi.fn() }),
}));
vi.mock('../../src/components/projects/project-chat-notice', () => ({
  ProjectChatNotice: () => null,
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: ComponentProps<typeof Composer>) => {
    mocks.composer = props;
    return null;
  },
}));

const answer: ClassificationResponse = {
  mode: 'block',
  classes: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
  models: [
    {
      slug: 'plain',
      displayName: 'Plain',
      status: 'blocked',
      missing: [{ id: 'c1', name: 'Student records' }],
    },
    { slug: 'approved', displayName: 'Approved', status: 'ok', missing: [] },
  ],
};

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.composer = undefined;
  mocks.asked.length = 0;
  mocks.classification = undefined;
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
});

it('picks an approved model, not the forbidden default, in a labelled project', async () => {
  mocks.classification = answer;
  await act(() => root.render(<ChatHomePage projectId="p1" />));
  expect(mocks.asked).toContainEqual(['classification', 'project', 'p1']);
  expect(mocks.composer?.selectedModel?.slug).toBe('approved');
  expect(mocks.composer?.classification).toBe(answer);
});

it('starts on the ordinary default until the answer arrives, and when nothing is labelled', async () => {
  await act(() => root.render(<ChatHomePage projectId="p1" />));
  expect(mocks.composer?.selectedModel?.slug).toBe('plain');
  mocks.classification = { mode: 'off', classes: [], models: [] };
  await act(() => root.render(<ChatHomePage projectId="p1" />));
  expect(mocks.composer?.selectedModel?.slug).toBe('plain');
});

it('asks nothing, outside a project, where nothing can be labelled before the first message', async () => {
  await act(() => root.render(<ChatHomePage />));
  expect(mocks.asked.filter((key) => key[0] === 'classification')).toEqual([]);
  expect(mocks.composer?.selectedModel?.slug).toBe('plain');
  expect(mocks.composer?.classification).toBeUndefined();
});

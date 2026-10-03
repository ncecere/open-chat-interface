// @vitest-environment happy-dom
import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composer } from '../../src/components/chat/composer';
import { ChatHomePage } from '../../src/routes/chat/home';

function model(slug: string, supportedEfforts: ReasoningEffort[]): CatalogModel {
  return {
    slug,
    isDefault: slug === 'thinker',
    supportedEfforts,
    capabilities: supportedEfforts.length > 0 ? ['effort_control'] : [],
  } as unknown as CatalogModel;
}

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  composer: undefined as ComponentProps<typeof Composer> | undefined,
  models: [] as CatalogModel[],
  me: undefined as unknown,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: mocks.models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: mocks.me }),
}));
vi.mock('../../src/hooks/use-threads', () => ({
  useCreateThread: () => ({ mutateAsync: mocks.create }),
}));
vi.mock('../../src/providers/temporary-chat-provider', () => ({
  useTemporaryChat: () => ({ temporary: false }),
}));
vi.mock('../../src/hooks/use-attachments', () => ({
  useAttachments: () => ({ items: [], upload: vi.fn(), remove: vi.fn() }),
}));
vi.mock('../../src/components/chat/composer', () => ({
  Composer: (props: ComponentProps<typeof Composer>) => {
    mocks.composer = props;
    return null;
  },
}));

function signedIn(defaultEffort: ReasoningEffort) {
  return {
    user: { name: 'Pat Example' },
    features: { webSearch: false, attachments: false },
    chat: { defaultEffort, reasoningEfforts: ['instant', 'low', 'medium', 'high'] },
  };
}

let root: Root | undefined;
async function render() {
  root = createRoot(document.createElement('div'));
  await act(() => root!.render(<ChatHomePage />));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  localStorage.clear();
  mocks.create.mockReset().mockResolvedValue({ thread: { id: 'destination' } });
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  mocks.models = [model('thinker', ['instant', 'low', 'medium']), model('quick', ['instant'])];
  mocks.me = undefined;
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
});

describe('composer default reasoning level', () => {
  it('starts at the administrator default when the model allows it', async () => {
    mocks.me = signedIn('medium');
    await render();
    expect(mocks.composer?.effort).toBe('medium');

    await act(() => mocks.composer!.onChange('Question'));
    await act(() => mocks.composer!.onSubmit());
    expect(sessionStorage.getItem('oci.pendingEffort')).toBe('medium');
  });

  it('clamps to instant when the model or role does not offer the default', async () => {
    mocks.me = signedIn('high');
    await render();
    // The catalog lists only levels the role may use, so "high" is absent.
    expect(mocks.composer?.effort).toBe('instant');
  });

  it('falls back to instant when no default is known', async () => {
    mocks.me = { user: { name: 'Pat' }, features: {} };
    await render();
    expect(mocks.composer?.effort).toBe('instant');
  });

  it('re-applies the default for each model until a level is picked', async () => {
    mocks.me = signedIn('low');
    await render();
    expect(mocks.composer?.effort).toBe('low');

    await act(() => mocks.composer!.onSelectModel(mocks.models[1]!));
    expect(mocks.composer?.effort).toBe('instant');
    await act(() => mocks.composer!.onSelectModel(mocks.models[0]!));
    expect(mocks.composer?.effort).toBe('low');

    await act(() => mocks.composer!.onEffortChange('medium'));
    expect(mocks.composer?.effort).toBe('medium');
    await act(() => mocks.composer!.onSelectModel(mocks.models[1]!));
    expect(mocks.composer?.effort).toBe('instant');
  });

  it('starts from the person’s default model and level, and hands the choice to the conversation (v0.10)', async () => {
    mocks.models = [
      model('thinker', ['instant', 'low', 'medium']),
      model('quick', ['instant']),
      model('deep', ['instant', 'low', 'medium', 'high']),
    ];
    // The server sends the person's level as the starting one when it applies.
    mocks.me = {
      ...signedIn('high'),
      chat: {
        defaultEffort: 'high',
        defaultModelSlug: 'deep',
        reasoningEfforts: ['instant', 'low', 'medium', 'high'],
      },
    };
    localStorage.setItem('oci.model', 'quick');
    await render();
    expect(mocks.composer?.selectedModel?.slug).toBe('deep');
    expect(mocks.composer?.effort).toBe('high');
    // The per-browser model from before v0.10 is forgotten, not used.
    expect(localStorage.getItem('oci.model')).toBeNull();

    // A model picked here applies to the conversation it starts.
    await act(() => mocks.composer!.onSelectModel(mocks.models[1]!));
    expect(mocks.composer?.selectedModel?.slug).toBe('quick');
    expect(mocks.composer?.effort).toBe('instant');
    await act(() => mocks.composer!.onChange('Question'));
    await act(() => mocks.composer!.onSubmit());
    expect(sessionStorage.getItem('oci.pendingModel')).toBe('quick');
    expect(localStorage.getItem('oci.model')).toBeNull();
  });

  it('falls back to the instance default when the person has no usable default', async () => {
    mocks.me = { ...signedIn('low'), chat: { ...signedIn('low').chat, defaultModelSlug: null } };
    await render();
    expect(mocks.composer?.selectedModel?.slug).toBe('thinker');
    expect(mocks.composer?.effort).toBe('low');
  });
});

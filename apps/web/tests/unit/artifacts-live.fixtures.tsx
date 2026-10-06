import type { ArtifactSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { ThreadArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import { MessageList } from '../../src/components/chat/message-list';
import { settle } from './admin-test-utils';
import { mockViewport } from './artifacts.fixtures';

/**
 * Live artifacts (v0.9): the card and panel while a reply writes an artifact
 * through the tools, opening the panel by itself on wide screens, and the
 * readable details of an artifact tool call.
 *
 * Shared setup for the artifacts-live-*.test.tsx files. Each test file
 * declares its own `vi.mock` calls and `api` mock (Vitest hoists them per
 * file), and its own `root`, `container` and `listed`, which the tests assign.
 */

export type LiveArtifactApiMock = { get: Mock; post: Mock };

export const PAGE = '<!doctype html><title>Sign up</title><form>FORM_BODY</form>';
export const created = (overrides: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: 'art-page',
  threadId: 'thread-1',
  messageId: 'reply-1',
  sourceKey: 'tool:call-1',
  title: 'Sign-Up Page',
  kind: 'html',
  language: null,
  currentVersion: 1,
  sizeBytes: PAGE.length,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const prompt: UIMessage = {
  id: 'prompt-1',
  role: 'user',
  parts: [{ type: 'text', text: 'A page' }],
};

export function createPart(state: string, input: Record<string, unknown>, extra = {}) {
  return { type: 'tool-create_artifact', toolCallId: 'call-1', state, input, ...extra } as never;
}
export function reply(...parts: UIMessage['parts']): UIMessage {
  return { id: 'reply-1', role: 'assistant', parts };
}
export const savedOutput = {
  output: { artifactId: 'art-page', title: 'Sign-Up Page', kind: 'html', version: 1, sizeBytes: 9 },
};

let setConversation: (messages: UIMessage[], streaming: boolean) => void = () => {};

function Conversation({ initial, streaming }: { initial: UIMessage[]; streaming: boolean }) {
  const [state, setState] = useState({ messages: initial, streaming });
  setConversation = (messages, next) => setState({ messages, streaming: next });
  return (
    <ThreadArtifactsProvider
      threadId="thread-1"
      messages={state.messages}
      streaming={state.streaming}
      canEdit
    >
      <MessageList messages={state.messages} streaming={state.streaming} onRetry={() => {}} />
      <textarea aria-label="Message input" />
    </ThreadArtifactsProvider>
  );
}

export async function stream(messages: UIMessage[], streaming = true) {
  await act(async () => setConversation(messages, streaming));
  await settle();
}
/** Highlighting a source being written is throttled; let it catch up. */
export const caughtUp = () => act(() => new Promise((resolve) => setTimeout(resolve, 450)));

/**
 * The conversation helpers, bound to the test file's own `container`.
 * `mounted` receives the React root and container before anything renders.
 */
export function liveHarness(state: {
  container: () => HTMLElement;
  mounted: (root: Root, container: HTMLElement) => void;
}) {
  async function mount(initial: UIMessage[] = [prompt], streaming = false) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    state.mounted(root, container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Conversation initial={initial} streaming={streaming} />
        </QueryClientProvider>,
      ),
    );
    await settle();
  }

  const docked = () => state.container().querySelector<HTMLElement>('aside[data-artifact-panel]');
  const announcer = () =>
    state.container().parentElement!.querySelector('[data-artifact-announcer]');
  const composer = () =>
    state.container().querySelector<HTMLTextAreaElement>('[aria-label="Message input"]')!;

  /** A reply written in this tab: sent, then streaming its artifact call. */
  async function startLiveReply(input: Record<string, unknown>) {
    await mount();
    composer().focus();
    await stream([prompt]);
    await stream([prompt, reply(createPart('input-streaming', input))]);
  }

  return { mount, docked, announcer, composer, startLiveReply };
}

/** The `beforeEach` of every live artifacts test: a wide screen and the API answers. */
export function resetLiveArtifactTest(api: LiveArtifactApiMock, listed: () => ArtifactSummary[]) {
  mockViewport(1280);
  localStorage.clear();
  api.get.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/artifacts?threadId=')) return { artifacts: listed() };
    const id = /^\/artifacts\/([^/?]+)$/.exec(path)?.[1];
    const artifact =
      listed().find((entry) => entry.id === id) ?? (id === 'art-page' ? created() : null);
    if (artifact)
      return {
        artifact,
        versions: [
          {
            version: 1,
            sizeBytes: 9,
            source: 'reply',
            messageId: 'reply-1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        content: PAGE,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
}

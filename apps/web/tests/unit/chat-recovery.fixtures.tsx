import { Chat, useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { type Mock, vi } from 'vitest';
import { type ChatConnectionScope, useChatRecovery } from '../../src/hooks/use-chat-recovery';
import { useChatSession } from '../../src/hooks/use-chat-session';
import type { ChatHistory } from '../../src/lib/chat-history';

/**
 * Shared setup for the chat-recovery-*.test.tsx files. Each test file declares
 * its own `vi.mock` calls (Vitest hoists them per file) and its own `root`,
 * `session`, `core`, `network` and `clearRun`, which `recoveryHarness` reads
 * and writes through the accessors it is given.
 */

export type RecoverySession = ReturnType<typeof useChatSession>;
export type RecoveryCore = {
  chat: ReturnType<typeof useChat>;
  recovery: ReturnType<typeof useChatRecovery>;
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function messages(text: string, status = 'complete'): UIMessage[] {
  return [
    { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    {
      id: 'assistant-1',
      role: 'assistant',
      metadata: { status },
      parts: [{ type: 'text', text }],
    },
  ];
}
export function history(saved = messages('Canonical answer'), threadId = 'thread'): ChatHistory {
  return {
    thread: { id: threadId, temporary: false, expiresAt: null },
    messages: saved,
    replies: [],
  };
}
export function sse(runId?: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const headers = new Headers({
    'content-type': 'text/event-stream',
    'x-vercel-ai-ui-message-stream': 'v1',
  });
  if (runId) headers.set('X-OCI-Chat-Run-Id', runId);
  return {
    response: new Response(body, { headers }),
    push(chunk: Record<string, unknown>) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    close() {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}

export const initialPending = () => {
  const pending = messages('', 'streaming');
  pending[1]!.parts = [];
  return pending;
};

// Drain the SDK's promise/ReadableStream jobs without advancing the recovery
// clock. Every pending IO operation is controlled by an explicit deferred gate.
export async function settle(action?: () => void) {
  await act(async () => {
    action?.();
    for (let job = 0; job < 100; job++) await Promise.resolve();
  });
}
export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The harness components and helpers, bound to the test file's own state. */
export function recoveryHarness(state: {
  root: () => Root;
  network: () => Mock<typeof fetch>;
  clearRun: () => Mock<(id: string) => void>;
  onSession: (session: RecoverySession) => void;
  onCore: (core: RecoveryCore) => void;
}) {
  function SessionHarness({
    threadId = 'thread',
    initialMessages = [],
  }: {
    threadId?: string;
    initialMessages?: UIMessage[];
  }) {
    state.onSession(useChatSession({ threadId, initialMessages }));
    return null;
  }
  function CoreHarness({
    sdk,
    scope,
    initialMessages,
    runId = null,
  }: {
    sdk: Chat<UIMessage>;
    scope: ChatConnectionScope;
    initialMessages: UIMessage[];
    runId?: string | null;
  }) {
    const chat = useChat({ chat: sdk, resume: false });
    const recovery = useChatRecovery({
      threadId: sdk.id,
      initialMessages,
      chat,
      scope,
      runId,
      clearRun: state.clearRun(),
    });
    state.onCore({ chat, recovery });
    return null;
  }
  function makeSdk(initialMessages: UIMessage[] = [], threadId = 'thread') {
    return new Chat<UIMessage>({
      id: threadId,
      messages: initialMessages,
      transport: new DefaultChatTransport({
        api: '/api/chat',
        fetch: state.network(),
        prepareReconnectToStreamRequest: () => ({ api: `/api/chat/${threadId}/stream` }),
      }),
    });
  }
  async function mount(initialMessages: UIMessage[] = []) {
    await settle(() => state.root().render(<SessionHarness initialMessages={initialMessages} />));
  }
  function chatPosts() {
    return state
      .network()
      .mock.calls.filter(
        ([input, init]) => String(input) === '/api/chat' && init?.method === 'POST',
      );
  }
  return { SessionHarness, CoreHarness, makeSdk, mount, chatPosts };
}

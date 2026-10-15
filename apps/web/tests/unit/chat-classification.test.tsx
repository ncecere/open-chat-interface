// @vitest-environment happy-dom
import type { ClassificationResponse } from '@oci/shared';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';
import { blockedDetailsOf, blockedSlugs } from '../../src/lib/classification';

/**
 * A send the server refuses because the conversation carries a data class the
 * model is not approved for (403 DATA_CLASS_BLOCKED, v0.14, #395): the text
 * goes back to the message box, like any refused send, and the refusal says
 * which models are approved.
 */
const { queryClient, models } = vi.hoisted(() => ({
  queryClient: { invalidateQueries: vi.fn() },
  models: [
    { slug: 'plain', isDefault: true, supportedEfforts: [], capabilities: [] },
    { slug: 'approved', isDefault: false, supportedEfforts: [], capabilities: [] },
  ],
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));

const earlier: UIMessage[] = [
  { id: 'saved-user', role: 'user', parts: [{ type: 'text', text: 'Earlier question' }] },
  { id: 'saved-reply', role: 'assistant', parts: [{ type: 'text', text: 'Earlier answer' }] },
];

const classification = (mode: 'warn' | 'block'): ClassificationResponse => ({
  mode,
  classes: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
  models: [
    {
      slug: 'plain',
      displayName: 'Plain model',
      status: mode === 'block' ? 'blocked' : 'warn',
      missing: [{ id: 'c1', name: 'Student records' }],
    },
    { slug: 'approved', displayName: 'Approved model', status: 'ok', missing: [] },
  ],
});

let root: Root;
let session: ReturnType<typeof useChatSession>;
function Harness({
  classification: answer,
  modelSlug,
}: {
  classification?: ClassificationResponse | undefined;
  modelSlug?: string | null;
}) {
  session = useChatSession({
    threadId: 'thread',
    initialMessages: earlier,
    classification: answer,
    initialModelSlug: modelSlug ?? null,
  });
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

const body = {
  error: {
    code: 'DATA_CLASS_BLOCKED',
    message:
      'Your message was not sent. Plain model is not approved for Student records, which this conversation carries. Choose a model that is approved for it.',
    details: {
      point: 'send',
      model: { slug: 'plain', displayName: 'Plain model' },
      missing: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
      approvedModels: [{ slug: 'approved', displayName: 'Approved model' }],
    },
  },
};

it('keeps the text in the box, drops the unsaved bubble, and carries the approved models', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  await act(() => root.render(<Harness modelSlug="plain" />));
  await act(() => session.setDraft('Marks for J. Smith'));
  await act(() => session.send());

  expect(session.draft).toBe('Marks for J. Smith');
  expect(session.messages.map((message) => message.id)).toEqual(['saved-user', 'saved-reply']);
  expect(session.refused).toBe(true);
  const details = blockedDetailsOf(session.error);
  expect(details?.point).toBe('send');
  expect(details?.approvedModels).toEqual([{ slug: 'approved', displayName: 'Approved model' }]);
});

it('starts on an approved model when the default is forbidden, and on the default when it is not', async () => {
  await act(() => root.render(<Harness classification={classification('block')} />));
  expect(session.selectedModel?.slug).toBe('approved');
  // In warn nothing is forbidden, so the ordinary default stands.
  await act(() => root.render(<Harness classification={classification('warn')} />));
  expect(session.selectedModel?.slug).toBe('plain');
  await act(() => root.render(<Harness />));
  expect(session.selectedModel?.slug).toBe('plain');
});

it('keeps the model the conversation last used even when it is now forbidden, so the person decides', async () => {
  await act(() =>
    root.render(<Harness classification={classification('block')} modelSlug="plain" />),
  );
  expect(session.selectedModel?.slug).toBe('plain');
  expect([...blockedSlugs(classification('block'))]).toEqual(['plain']);
  // Picking an approved model switches at once.
  await act(() => session.selectModel(models[1] as never));
  expect(session.selectedModel?.slug).toBe('approved');
});

it('asks the server again after a reply, since a tool it used may have added a label', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const chunks = [
        { type: 'start', messageId: 'run' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Answer' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: 'stop' },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        {
          headers: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
            'X-OCI-Chat-Run-Id': 'run',
          },
        },
      );
    }),
  );
  await act(() => root.render(<Harness />));
  await act(() => session.send('A question'));
  await vi.waitFor(() =>
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['classification'] }),
  );
});

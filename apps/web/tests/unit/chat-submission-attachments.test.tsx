// @vitest-environment happy-dom
import { type Attachment, type SendMessageInput, sendMessageSchema } from '@oci/shared';
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatSession } from '../../src/hooks/use-chat-session';

// Keep the session, SDK transport/stream parser, and attachment resource owner real.
const { queryClient, models } = vi.hoisted(() => ({
  queryClient: { invalidateQueries: vi.fn() },
  models: [
    {
      slug: 'model',
      isDefault: true,
      reasoningMode: 'none',
      supportedEfforts: [],
      capabilities: [],
    },
  ],
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: models }) }));
vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: undefined }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function attachment(id: string, filename = `${id}.txt`, mimeType = 'text/plain'): Attachment {
  return {
    id,
    filename,
    mimeType,
    sizeBytes: 4,
    url: `/api/attachments/${id}/content`,
    thumbnailUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
const A = attachment('attachment-a');
const B = attachment('attachment-b');
const storedUserId = 'dcb349dd-8d86-4391-a252-6c199025a6aa';
const card = ({ id, filename, mimeType, url }: Attachment) => ({
  type: 'data-attachment' as const,
  data: { id, filename, mimeType, url },
});
const storedUser: UIMessage = {
  id: storedUserId,
  role: 'user',
  parts: [{ type: 'text', text: 'Stored question' }, card(A)],
};

function liveResponse(runId: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const emit = (chunk: unknown) =>
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  emit({ type: 'start', messageId: runId });
  emit({ type: 'text-start', id: 'text' });
  emit({ type: 'text-delta', id: 'text', delta: 'Answer' });
  return {
    response: new Response(body, {
      status: 200,
      headers: { ...UI_MESSAGE_STREAM_HEADERS, 'X-OCI-Chat-Run-Id': runId },
    }),
    finish() {
      emit({ type: 'text-end', id: 'text' });
      emit({ type: 'finish', finishReason: 'stop' });
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  };
}

type HeaderGate = ReturnType<typeof deferred<Response>>;
let root: Root;
let container: HTMLDivElement;
let session: ReturnType<typeof useChatSession>;
let headers: HeaderGate[];
let uploads: Map<string, HeaderGate>;
let uploadRequests: Map<string, { signal: AbortSignal; aborted: ReturnType<typeof vi.fn> }>;
let posts: SendMessageInput[];
let deletions: string[];
let unexpected: string[];
let runNumber: number;
let canonical: UIMessage[] | null;

function Harness({
  messages,
  carriedAttachments,
}: {
  messages?: UIMessage[];
  carriedAttachments?: Attachment[];
}) {
  session = useChatSession({ threadId: 'thread', initialMessages: messages, carriedAttachments });
  return (
    <ul aria-label="Composer attachments">
      {session.attachments.items.map((item) => (
        <li key={item.localId} data-status={item.status}>
          {item.filename}
        </li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  vi.clearAllMocks();
  headers = [];
  uploads = new Map();
  uploadRequests = new Map();
  posts = [];
  deletions = [];
  unexpected = [];
  runNumber = 0;
  canonical = null;
  container = document.createElement('div');
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/chat' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string));
        const gate = headers.shift();
        if (gate) return gate.promise;
      } else if (url === '/api/attachments' && init?.method === 'POST') {
        const file = (init.body as FormData).get('files') as File;
        const gate = uploads.get(file.name);
        if (gate && init.signal) {
          uploads.delete(file.name);
          const signal = init.signal;
          const aborted = vi.fn();
          uploadRequests.set(file.name, { signal, aborted });
          // Model fetch cancellation, not just a promise that ignores AbortSignal.
          return new Promise<Response>((resolve, reject) => {
            const onAbort = () => {
              aborted();
              reject(new DOMException('Upload aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
            void gate.promise.then((response) => {
              signal.removeEventListener('abort', onAbort);
              resolve(response);
            });
          });
        }
      } else if (url.startsWith('/api/chat/thread/messages') && canonical) {
        return Response.json({
          thread: { id: 'thread', temporary: false, expiresAt: null },
          messages: canonical,
        });
      } else if (url.startsWith('/api/attachments/') && init?.method === 'DELETE') {
        deletions.push(url);
        return new Response(null, { status: 204 });
      }
      // No fallback to the real network, nor fabricated history to mask recovery.
      unexpected.push(`${init?.method ?? 'GET'} ${url}`);
      throw new Error(`Unexpected request: ${unexpected.at(-1)}`);
    }),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(unexpected, 'No history GET, reconnect, or unplanned network request').toEqual([]);
});

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => root.render(<Harness {...props} />));
  expect(session.selectedModel?.slug).toBe('model');
}

async function startUpload(file: Attachment) {
  const gate = deferred<Response>();
  uploads.set(file.filename, gate);
  let completion!: Promise<void>;
  await act(() => {
    completion = session.attachments.upload([
      new File(['data'], file.filename, { type: file.mimeType }),
    ]);
  });
  const request = uploadRequests.get(file.filename);
  expect(request, 'The real attachment hook must start the planned upload').toBeDefined();
  return {
    request: request!,
    async finish() {
      await act(async () => {
        gate.resolve(Response.json({ attachments: [file] }));
        await completion;
      });
    },
  };
}

async function uploadReady(file: Attachment) {
  const upload = await startUpload(file);
  await upload.finish();
  expect(session.attachments.readyIds).toContain(file.id);
  return upload;
}

async function startSend(text = 'Question') {
  const gate = deferred<Response>();
  headers.push(gate);
  let completion!: Promise<void>;
  let settled = false;
  await act(() => {
    completion = session.send(text).then(() => {
      settled = true;
    });
  });
  expect(session.status).toBe('submitted');
  expect(settled, 'Do not await send while headers or SSE are still pending').toBe(false);
  return { gate, completion, settled: () => settled };
}

async function accept(send: Awaited<ReturnType<typeof startSend>>) {
  const stream = liveResponse(`run-${++runNumber}`);
  await act(() => {
    send.gate.resolve(stream.response);
  });
  expect(session.status).toBe('streaming');
  expect(send.settled()).toBe(false);
  return {
    async finish() {
      await act(async () => {
        stream.finish();
        await send.completion;
      });
      expect(send.settled()).toBe(true);
      expect(session.status).toBe('ready');
      expect(session.error).toBeUndefined();
      expect(session.messages.at(-1)?.parts).toContainEqual({
        type: 'text',
        text: 'Answer',
        state: 'done',
      });
    },
  };
}

function userCards(index = 0) {
  return session.messages
    .filter((message) => message.role === 'user')
    [index]?.parts.filter((part) => part.type === 'data-attachment');
}

it('consumes submitted A after a healthy SDK completion but preserves ready next-turn B', async () => {
  await mount();
  await uploadReady(A);
  const send = await startSend();
  const stream = await accept(send);
  expect(session.attachments.readyIds).toEqual([]); // Accepted files leave the composer before completion.
  await uploadReady(B);
  // Completion must not consume the next batch.
  await stream.finish();
  expect(posts[0]?.attachmentIds).toEqual([A.id]);
  expect(userCards()).toEqual([card(A)]);
  expect(session.attachments.readyIds).toEqual([B.id]);
  expect(session.attachments.items.map((item) => item.attachment?.id)).toEqual([B.id]);
  expect(deletions).toEqual([]);
});

it('does not abort pending next-turn B when A completes, and shows B when its upload finishes', async () => {
  await mount();
  await uploadReady(A);
  const stream = await accept(await startSend());
  const next = await startUpload(B);
  expect(session.attachments.items.find((item) => item.filename === B.filename)?.status).toBe(
    'uploading',
  );
  await stream.finish();
  // Soft assertions let the independent upload-completion checks run even on the regression.
  expect.soft(next.request.signal.aborted).toBe(false);
  expect.soft(next.request.aborted).not.toHaveBeenCalled();
  expect
    .soft(session.attachments.items.find((item) => item.filename === B.filename)?.status)
    .toBe('uploading');
  await next.finish();
  expect.soft(session.attachments.readyIds).toEqual([B.id]);
  expect.soft(container.querySelector('[data-status="ready"]')?.textContent).toBe(B.filename);
  expect.soft(deletions).toEqual([]);
});

it('keeps original A retryable when HTTP 400 resolves the SDK send instead of rejecting it', async () => {
  await mount();
  await uploadReady(A);
  const send = await startSend();
  await act(async () => {
    send.gate.resolve(new Response('Preparation rejected', { status: 400 }));
    await expect(send.completion).resolves.toBeUndefined();
  });
  expect(send.settled()).toBe(true);
  expect(session.status).toBe('error');
  expect(session.error?.message).toContain('Preparation rejected');
  expect(posts).toHaveLength(1); // No automatic retry or history hydration.
  expect(posts[0]?.attachmentIds).toEqual([A.id]);
  // Refused before it was saved: text and file stay in the composer to send
  // again, and no bubble pretends the message was sent.
  expect(userCards()).toBeUndefined();
  expect(session.draft).toBe('Question');
  expect(session.attachments.readyIds).toEqual([A.id]);
  expect(session.attachments.items[0]?.status).toBe('ready');
});

it('retains both rejected A and B uploaded while preparation headers were pending', async () => {
  await mount();
  await uploadReady(A);
  const send = await startSend();
  await uploadReady(B);
  await act(async () => {
    send.gate.resolve(new Response('Preparation rejected', { status: 400 }));
    await expect(send.completion).resolves.toBeUndefined();
  });
  expect(session.status).toBe('error');
  expect(send.settled()).toBe(true);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.attachmentIds).toEqual([A.id]);
  expect(userCards()).toBeUndefined();
  expect(session.attachments.readyIds).toEqual([A.id, B.id]);
  expect(session.attachments.items.map((item) => item.status)).toEqual(['ready', 'ready']);
});

it('revokes only consumed image A preview, not the next-turn image B preview', async () => {
  const imageA = attachment('image-a', 'a.png', 'image/png');
  const imageB = attachment('image-b', 'b.png', 'image/png');
  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation((blob) => `blob:preview/${(blob as File).name}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await mount();
  await uploadReady(imageA);
  const stream = await accept(await startSend());
  await uploadReady(imageB);
  await stream.finish();
  expect(create).toHaveBeenCalledTimes(2);
  expect.soft(revoke.mock.calls).toEqual([['blob:preview/a.png']]);
  expect.soft(revoke).not.toHaveBeenCalledWith('blob:preview/b.png');
  expect.soft(session.attachments.readyIds).toEqual([imageB.id]);
  expect
    .soft(session.attachments.items.find((item) => item.attachment?.id === imageB.id)?.previewUrl)
    .toBe('blob:preview/b.png');
});

it('snapshots exact sent IDs and cards before later files arrive during headers and streaming', async () => {
  const C = attachment('attachment-c');
  await mount();
  await uploadReady(A);
  const send = await startSend('Only A in this turn');
  await uploadReady(B); // Before response headers.
  const stream = await accept(send);
  await uploadReady(C); // After response headers, before SSE finishes.
  await stream.finish();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    attachmentIds: [A.id],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Only A in this turn' }] }],
    trigger: 'submit-message',
  });
  expect(userCards()).toEqual([card(A)]);
  expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(1);
});

it('regenerates a stored user with no new attachment IDs and leaves next-turn B ready', async () => {
  await mount({ messages: [storedUser] });
  await uploadReady(B);
  const gate = deferred<Response>();
  headers.push(gate);
  let completion!: Promise<void>;
  let settled = false;
  await act(() => {
    completion = session.regenerate({ messageId: storedUserId }).then(() => {
      settled = true;
    });
  });
  expect(session.status).toBe('submitted');
  const stream = await accept({ gate, completion, settled: () => settled });
  await stream.finish();
  expect(posts).toHaveLength(1);
  expect.soft(posts[0]?.attachmentIds).toEqual([]);
  expect(posts[0]?.trigger).toBe('regenerate-message');
  expect(posts[0]?.messages).toEqual([
    { id: storedUserId, role: 'user', parts: [{ type: 'text', text: 'Stored question' }] },
  ]);
  expect(userCards()).toEqual([card(A)]);
  expect(session.attachments.readyIds).toEqual([B.id]);
  expect(deletions).toEqual([]);
});

it.each([false, true])(
  'reconciles uncertain acceptance from persisted user files only (carried=%s)',
  async (carried) => {
    await mount(carried ? { carriedAttachments: [A] } : {});
    if (!carried) await uploadReady(A);
    const uncertain = await startSend();
    await act(async () => {
      uncertain.gate.resolve(new Response('Gateway lost the upstream response', { status: 502 }));
      await uncertain.completion;
    });
    expect(session.status).toBe('error');
    await uploadReady(B);
    canonical = [
      { ...storedUser, parts: [{ type: 'text', text: 'Question' }, card(A)] },
      { id: 'saved-answer', role: 'assistant', metadata: { status: 'complete' }, parts: [card(B)] },
    ];
    await act(() => session.setDraft('Next question'));
    await act(() => session.recovery.recover());
    expect(session.attachments.readyIds).toEqual([B.id]); // Assistant data cannot consume queued B.
    expect(session.draft).toBe('Next question');
    expect(session.error).toBeUndefined();
    const next = await accept(await startSend('Next question'));
    await next.finish();
    expect(posts[1]?.attachmentIds).toEqual([B.id]);
    expect(deletions).toEqual([]);
  },
);

it('consumes home-carried A once without consuming B queued for the following turn', async () => {
  await mount({ carriedAttachments: [A] });
  const first = await accept(await startSend('Carried from home'));
  await uploadReady(B);
  await first.finish();
  expect(posts[0]?.attachmentIds).toEqual([A.id]);
  expect(userCards(0)).toEqual([card(A)]);
  expect.soft(session.attachments.readyIds).toEqual([B.id]);

  const second = await accept(await startSend('Next turn with B'));
  await second.finish();
  expect.soft(posts[1]?.attachmentIds).toEqual([B.id]);
  expect.soft(userCards(1)).toEqual([card(B)]);
  expect(session.attachments.readyIds).toEqual([]);

  const third = await accept(await startSend('No files left'));
  await third.finish();
  expect(posts).toHaveLength(3);
  expect(posts.map((post) => post.attachmentIds.filter((id) => id === A.id))).toEqual([
    [A.id],
    [],
    [],
  ]);
  expect(posts[2]?.attachmentIds).toEqual([]);
  expect(userCards(2)).toEqual([]);
  expect(deletions).toEqual([]);
});

it('sends the project files left out with the next message only, then uses all again', async () => {
  await mount();
  await act(() => session.setExcludedProjectFileIds(['project-file-1', 'project-file-2']));
  const first = await startSend('First');
  expect(posts[0]?.excludedProjectFileIds).toEqual(['project-file-1', 'project-file-2']);
  expect(session.excludedProjectFileIds).toEqual([]);
  await (await accept(first)).finish();

  const second = await startSend('Second');
  expect(posts[1]).not.toHaveProperty('excludedProjectFileIds');
  await (await accept(second)).finish();
});

it("sends the browser's time zone with each message, in a body the API accepts (#248)", async () => {
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...resolved.call(this), timeZone: 'America/Los_Angeles' };
  });
  await mount();
  const send = await startSend('What is the date today?');
  expect(posts[0]?.timeZone).toBe('America/Los_Angeles');
  // The route's own strict schema: an unknown key would refuse every message.
  expect(sendMessageSchema.safeParse(posts[0]).success).toBe(true);
  await (await accept(send)).finish();
});

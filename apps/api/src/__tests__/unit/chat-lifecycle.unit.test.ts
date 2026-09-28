import type { UIMessageChunk } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedTurn } from '../../services/chat/prepare-turn.js';
import type { AcquiredRun } from '../../services/chat/run-lifecycle.js';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  claim: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  capture: vi.fn(),
  begin: vi.fn(),
  abandon: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  acquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  reserve: vi.fn(),
  releaseReservation: vi.fn(),
  settleReservation: vi.fn(),
  position: vi.fn(),
  touch: vi.fn(),
  convert: vi.fn(),
  streamText: vi.fn(),
  createStream: vi.fn(),
  createResponse: vi.fn(),
  logger: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update, delete: mocks.delete },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { error: mocks.logger } }));
vi.mock('../../services/chat-streams.js', () => ({
  beginChatRun: mocks.begin,
  abandonChatRun: mocks.abandon,
  registerLocalChatRun: mocks.register,
  unregisterLocalChatRun: mocks.unregister,
  isChatRunCancellationRequested: vi.fn().mockResolvedValue(false),
  captureChatRun: mocks.capture,
}));
vi.mock('../../services/limits/concurrency.js', () => ({ acquireStreamSlot: mocks.acquireSlot }));
vi.mock('../../services/chat/thread-claim.js', () => ({ claimThread: mocks.claim }));
vi.mock('../../services/quota/index.js', () => ({
  reserveQuotaForRun: mocks.reserve,
  releaseReservation: mocks.releaseReservation,
  settleReservation: mocks.settleReservation,
}));
vi.mock('../../services/threads.js', () => ({
  nextPosition: mocks.position,
  touchThread: mocks.touch,
}));
vi.mock('../../services/reasoning.js', () => ({ reasoningCallSettings: () => ({}) }));
vi.mock('ai', () => ({
  convertToModelMessages: mocks.convert,
  streamText: mocks.streamText,
  createUIMessageStream: mocks.createStream,
  createUIMessageStreamResponse: mocks.createResponse,
}));

import { acquireRun } from '../../services/chat/run-lifecycle.js';
import { streamResponse } from '../../services/chat/stream-response.js';

const turn = {
  user: { id: 'user', name: 'User', role: 'user' },
  input: { effort: null, webSearch: false },
  thread: { id: 'thread' },
  resolved: { slug: 'model', capabilities: [], providerKind: 'openai', languageModel: {} },
  promptMessageId: 'prompt',
  submittedMessageId: 'prompt',
  uiMessages: [],
  system: '',
  generationSettings: { maxOutputTokens: 4096 },
  sourceParts: [],
  searchGroundingPart: null,
} as unknown as PreparedTurn;
const reservation = {
  id: 'reservation',
  userId: 'user',
  modelSlug: 'model',
  pricing: { inputPriceMicros: 0, outputPriceMicros: 0 },
};
let updated: Record<string, unknown>[];
let onEnd: (payload: {
  responseMessage: { id: string; role: 'assistant'; parts: [] };
  isAborted: boolean;
}) => Promise<void> | undefined;
const endPayload = {
  responseMessage: { id: 'assistant', role: 'assistant' as const, parts: [] as [] },
  isAborted: false,
};

function run(): AcquiredRun {
  return {
    startedAt: Date.now(),
    runIdentity: { runId: 'run', userId: 'user', threadId: 'thread' },
    streamSlot: { release: mocks.releaseSlot },
    persistence: 'available',
    assistantMessage: { id: 'assistant' },
    reservation,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  updated = [];
  mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
  mocks.insert.mockReturnValue({
    values: () => ({ returning: async () => [{ id: 'assistant' }] }),
  });
  mocks.delete.mockReturnValue({ where: async () => undefined });
  mocks.update.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => {
      updated.push(patch);
      return { where: async () => undefined };
    },
  }));
  mocks.claim.mockResolvedValue({ id: 'assistant' });
  mocks.acquireSlot.mockResolvedValue({ release: mocks.releaseSlot });
  mocks.begin.mockResolvedValue('available');
  mocks.reserve.mockResolvedValue(reservation);
  mocks.position.mockResolvedValue(1);
  mocks.convert.mockResolvedValue([]);
  mocks.streamText.mockReturnValue({
    usage: Promise.resolve({ inputTokens: 2, outputTokens: 3 }),
    toUIMessageStream: vi.fn(),
  });
  mocks.createStream.mockImplementation((options: { onEnd: typeof onEnd }) => {
    onEnd = options.onEnd;
    return new ReadableStream();
  });
  mocks.createResponse.mockReturnValue(new Response('stream'));
});

describe('run acquisition rollback', () => {
  it('releases the slot if lock acquisition throws', async () => {
    const error = new Error('begin failed');
    mocks.begin.mockRejectedValue(error);
    await expect(acquireRun(turn)).rejects.toBe(error);
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.abandon).not.toHaveBeenCalled();
  });

  it('releases the slot when database admission fails, without touching Redis', async () => {
    const error = new Error('database unavailable');
    mocks.claim.mockRejectedValue(error);
    await expect(acquireRun(turn)).rejects.toBe(error);
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it('returns a provisional claim and reservation before preparation begins', async () => {
    expect(await acquireRun(turn)).toMatchObject({
      assistantMessage: { id: 'assistant' },
      turnPersisted: false,
      reservation,
    });
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.begin.mock.invocationCallOrder[0]!,
    );
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reserve.mock.invocationCallOrder[0]!,
    );
  });

  it('removes the provisional assistant and releases locks on quota denial without spending allowance', async () => {
    const denial = new Error('quota exceeded');
    mocks.reserve.mockRejectedValue(denial);
    await expect(acquireRun(turn)).rejects.toBe(denial);
    expect(updated).toEqual([]);
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.abandon).toHaveBeenCalledOnce();
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mocks.claim.mock.calls[0]?.[1],
        userId: 'user',
        modelSlug: 'model',
      }),
    );
    expect(mocks.settleReservation).not.toHaveBeenCalled();
  });

  it('retains the reservation identity for cleanup after an ambiguous admission reply', async () => {
    const failure = new Error('Reservation commit reply lost');
    mocks.reserve.mockRejectedValue(failure);
    await expect(acquireRun(turn)).rejects.toBe(failure);
    const attempted = mocks.reserve.mock.calls[0]?.[0];
    expect(attempted.runId).toBe(mocks.claim.mock.calls[0]?.[1]);
    expect(mocks.releaseReservation).toHaveBeenCalledWith(
      expect.objectContaining({ id: attempted.runId }),
    );
  });

  it('removes its provisional claim but never abandons the Redis winner', async () => {
    mocks.begin.mockResolvedValue('conflict');
    await expect(acquireRun(turn)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.abandon).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
  });

  it('cleans up independently when marking a failed row also fails', async () => {
    const denial = new Error('quota exceeded');
    mocks.reserve.mockRejectedValue(denial);
    mocks.delete.mockImplementation(() => {
      throw new Error('database down');
    });
    await expect(acquireRun(turn)).rejects.toBe(denial);
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.abandon).toHaveBeenCalledOnce();
    expect(mocks.logger).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'assistant row' }),
      'Chat run cleanup failed',
    );
  });
});

describe('SDK setup and completion cleanup', () => {
  it('returns the persisted prompt ID through the real SDK HTTP response headers', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    mocks.createStream.mockImplementation(actual.createUIMessageStream);
    mocks.createResponse.mockImplementation(actual.createUIMessageStreamResponse);
    mocks.streamText.mockReturnValue({
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 3 }),
      toUIMessageStream: () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.enqueue({ type: 'finish', finishReason: 'stop' });
            controller.close();
          },
        }),
    });
    const response = await streamResponse(turn, run());
    expect(response.headers.get('X-OCI-Prompt-Message-Id')).toBe(turn.promptMessageId);
    expect(response.headers.get('X-OCI-Chat-Run-Id')).toBeTruthy();
    await response.text();
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
  });

  it('sends the reserved output cap and persists the context notice through the real SDK parser', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    mocks.createStream.mockImplementation(actual.createUIMessageStream);
    let stream: ReadableStream<UIMessageChunk> | undefined;
    mocks.createResponse.mockImplementation(
      (options: { stream: ReadableStream<UIMessageChunk> }) => {
        stream = options.stream;
        return new Response('stream');
      },
    );
    const chunks: UIMessageChunk[] = [
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Answer' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop' },
    ];
    mocks.streamText.mockReturnValue({
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 3 }),
      toUIMessageStream: () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
    });
    await streamResponse(
      {
        ...turn,
        contextLimited: true,
        resolved: { ...turn.resolved, maxOutputTokens: 1234 },
        generationSettings: { maxOutputTokens: 1234 },
      },
      run(),
    );
    const messages = [];
    for await (const message of actual.readUIMessageStream({ stream: stream! }))
      messages.push(message);
    const notice = { type: 'data-context-window', data: { limited: true } };
    expect(messages.at(-1)?.parts).toContainEqual(notice);
    expect(updated.find((patch) => patch.status === 'complete')?.parts).toContainEqual(notice);
    expect(mocks.streamText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 1234 }),
    );
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
  });

  it.each(['convert', 'streamText'] as const)(
    'cleans every acquired resource if %s throws before model startup',
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      if (stage === 'convert') mocks.convert.mockRejectedValue(failure);
      else
        mocks.streamText.mockImplementation(() => {
          throw failure;
        });
      await expect(streamResponse(turn, run())).rejects.toBe(failure);
      expect(mocks.releaseSlot).toHaveBeenCalledOnce();
      expect(mocks.abandon).toHaveBeenCalledOnce();
      expect(mocks.unregister).toHaveBeenCalledWith('run');
      expect(mocks.releaseReservation).toHaveBeenCalledWith(reservation);
      expect(mocks.settleReservation).not.toHaveBeenCalled();
      expect(updated).toEqual([expect.objectContaining({ status: 'error' })]);
    },
  );

  it('aborts and settles rather than refunds a run if response construction fails after SDK startup', async () => {
    const failure = new Error('response failed');
    mocks.createResponse.mockImplementation(() => {
      throw failure;
    });
    await expect(streamResponse(turn, run())).rejects.toBe(failure);
    expect(mocks.register.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(mocks.settleReservation).toHaveBeenCalledWith(reservation, null);
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    // A late SDK completion cannot double-settle or overwrite the failure.
    await onEnd(endPayload);
    expect(mocks.settleReservation).toHaveBeenCalledOnce();
    expect(updated).toHaveLength(1);
  });

  it('leaves finalization to an already-started SSE consumer and publishes the setup error', async () => {
    const failure = new Error('response failed after capture started');
    mocks.createResponse.mockImplementation(
      (options: { consumeSseStream: (input: { stream: ReadableStream<string> }) => void }) => {
        options.consumeSseStream({ stream: new ReadableStream() });
        throw failure;
      },
    );
    await expect(streamResponse(turn, run())).rejects.toBe(failure);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.abandon).not.toHaveBeenCalled();
    const outcome = mocks.capture.mock.calls[0]?.[2] as () => { status: string };
    expect(outcome()).toMatchObject({ status: 'error', error: 'Stream setup failed' });
    await onEnd(endPayload);
    expect(outcome().status).toBe('error');
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
  });

  it('still frees handles if reservation cleanup itself fails, without replacing the original error', async () => {
    const failure = new Error('conversion failed');
    mocks.convert.mockRejectedValue(failure);
    mocks.releaseReservation.mockRejectedValue(new Error('quota store down'));
    await expect(streamResponse(turn, run())).rejects.toBe(failure);
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.abandon).toHaveBeenCalledOnce();
    expect(mocks.unregister).toHaveBeenCalledWith('run');
  });

  it('settles usage even when storing the completed assistant fails', async () => {
    await streamResponse(turn, run());
    mocks.update.mockImplementation(() => {
      throw new Error('write failed');
    });
    await onEnd(endPayload);
    expect(mocks.settleReservation).toHaveBeenCalledWith(reservation, {
      tokensIn: 2,
      tokensOut: 3,
    });
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.unregister).toHaveBeenCalledWith('run');
  });

  it('reports both persistence and settlement errors without masking the initiating failure', async () => {
    const writeFailure = new Error('write failed');
    const settlementFailure = new Error('settlement failed');
    await streamResponse(turn, run());
    mocks.update.mockImplementation(() => {
      throw writeFailure;
    });
    mocks.settleReservation.mockRejectedValue(settlementFailure);
    await onEnd(endPayload);
    expect(mocks.logger).toHaveBeenCalledWith(
      expect.objectContaining({ error: settlementFailure }),
      'Failed to settle chat usage',
    );
    expect(mocks.logger).toHaveBeenCalledWith(
      expect.objectContaining({ error: writeFailure }),
      'Failed to persist assistant message',
    );
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
  });

  it('finalizes successful completion once and leaves Redis finalization to stream capture', async () => {
    const response = await streamResponse(turn, run());
    expect(response.status).toBe(200);
    await Promise.all([onEnd(endPayload), onEnd(endPayload)]);
    expect(updated).toEqual([
      expect.objectContaining({ status: 'complete', tokensIn: 2, tokensOut: 3 }),
    ]);
    expect(mocks.settleReservation).toHaveBeenCalledOnce();
    expect(mocks.releaseSlot).toHaveBeenCalledOnce();
    expect(mocks.abandon).not.toHaveBeenCalled();
  });
});

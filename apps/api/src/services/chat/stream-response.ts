import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from 'ai';
import { logger } from '../../lib/logger.js';
import { runAbortReason } from '../../lib/run-abort.js';
import {
  type ChatRunStatus,
  captureChatRun,
  isChatRunCancellationRequested,
  registerLocalChatRun,
} from '../chat-streams.js';
import { recordHandoff, reportThrottle } from '../limits/capacity/index.js';
import type { CapacityLease, CapacityRequest, WaitOutcome } from '../limits/capacity/queue.js';
import {
  observeChatReply,
  observeProviderFirstOutput,
  observeReplyStart,
} from '../observability/events.js';
import { recordDrainInterruptedReply } from '../observability/interrupted.js';
import { withProviderRetries } from '../providers/retry.js';
import { buildSdkTools, toolApprovalPolicy } from '../tools/registry.js';
import { stoppedByShutdown, trackRun } from './active-runs.js';
import {
  admitTurn,
  CAPACITY_HANDOFF_MESSAGE,
  capacityTimeoutMessage,
  waitForCapacity,
} from './capacity-wait.js';
import { isContextOverflowError } from './compaction-plan.js';
import { scheduleCompactionAfterReply } from './compaction-queue.js';
import type { PreparedTurn } from './prepare-turn.js';
import { failRunSetup, releaseRunHandles } from './run-cleanup.js';
import type { AcquiredRun } from './run-lifecycle.js';
import { persistAssistant, type ReplyUsage } from './run-save.js';
import { createToolLoop, stepsTaken, toolStreamErrorText } from './tool-loop.js';

type RunOutcome = { status: Exclude<ChatRunStatus, 'active'>; error?: string };

/**
 * Whether the provider refused the request as too long before producing any
 * output. Reads a copy of the stream up to its first event, so the reply's
 * own reading is unaffected.
 */
async function overflowedBeforeOutput(
  result: Pick<ReturnType<typeof streamText>, 'fullStream'>,
): Promise<boolean> {
  const reader = result.fullStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.type === 'start' || value.type === 'start-step') continue;
      return value.type === 'error' && isContextOverflowError(value.error);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * Usage of this run. With tools the SDK's total covers every finished step of
 * a completed reply, but is empty after a stop; the loop's per-step tally then
 * reports the finished steps as a lower bound.
 */
async function runUsage(
  result: Pick<ReturnType<typeof streamText>, 'usage'>,
  loop: ReturnType<typeof createToolLoop> | null,
  status: RunOutcome['status'],
): Promise<ReplyUsage> {
  let total: Awaited<ReturnType<typeof streamText>['usage']> | undefined;
  try {
    total = await result.usage;
  } catch {
    total = undefined;
  }
  return loop ? loop.settlement(total, status === 'complete') : (total ?? null);
}

/**
 * Start the provider and compose its persisted, resumable SDK response.
 * `receivedAt` (performance.now()) is when the request arrived, for the
 * reply-start objective (docs/dev/slo.md).
 */
export async function streamResponse(
  turn: PreparedTurn,
  run: AcquiredRun,
  timing: { receivedAt?: number } = {},
) {
  const { input, thread, resolved, uiMessages, system, sourceParts, searchGroundingPart } = turn;
  const { runIdentity, assistantMessage, persistence } = run;
  const abortController = new AbortController();
  let modelStarted = false;
  let setupFailed = false;
  let completion: Promise<void> | undefined;
  let capture: Promise<void> | undefined;
  let untrack: (() => void) | undefined;
  let captureStarted = false;
  let outcome: RunOutcome = { status: 'complete' };
  // Provider capacity (v0.11): admitted at once, or queued until the stream
  // has begun so the reader sees its place. Ended without a reply when the
  // wait was stopped, ran out, or this replica began draining.
  let capacity: CapacityRequest | undefined;
  let lease: CapacityLease | undefined;
  let unadmitted: Exclude<WaitOutcome, { kind: 'admitted' }> | undefined;
  try {
    // A model without tool calling (or a turn with no tool switched on) runs
    // exactly as in v0.7: one step, no tools.
    const sdkTools = turn.tools.definitions.length
      ? buildSdkTools(
          turn.tools,
          {
            userId: turn.user.id,
            role: turn.user.role,
            threadId: thread.id,
            messageId: assistantMessage.id,
          },
          turn.continuation?.approved,
        )
      : null;
    // One attempt at the reply: its own tool loop and provider stream. A
    // retry after the provider reported the input too long is a fresh one.
    const prepareAttempt = async (attemptMessages: UIMessage[], attemptSystem: string) => ({
      uiMessages: attemptMessages,
      system: attemptSystem,
      // A continued reply always records its approval answers, even when no
      // tool is offered any more.
      loop:
        sdkTools || turn.continuation
          ? createToolLoop({
              tools: turn.tools,
              maxSteps: turn.maxToolSteps,
              previousSteps: turn.continuation ? stepsTaken(turn.continuation.existingParts) : 0,
              user: turn.user,
              modelSlug: resolved.slug,
              runId: runIdentity.runId,
              messageCount: turn.continuation ? 0 : 1,
              threadId: thread.id,
              messageId: assistantMessage.id,
              resolved,
              system: attemptSystem,
              uiMessages: attemptMessages,
            })
          : null,
      messages: await convertToModelMessages(
        attemptMessages,
        sdkTools ? { tools: sdkTools } : undefined,
      ),
    });
    // Retries a provider's "not now" before the first output, tells the
    // limiter, and counts each later request of this reply (tool steps).
    const model = withProviderRetries(resolved.languageModel, {
      signal: abortController.signal,
      onExtraRequest: () => lease?.chargeRequest(),
      onThrottle: (throttle) => void reportThrottle(resolved, throttle),
      // Service objectives: what OCI added before the model was asked (less
      // the capacity wait, exported on its own), and the provider's part.
      onFirstRequest: () => {
        if (timing.receivedAt !== undefined)
          observeReplyStart(
            performance.now() - timing.receivedAt - (lease?.queued ? lease.waitedMs : 0),
          );
      },
      onFirstOutput: (ms) =>
        observeProviderFirstOutput(
          resolved.providerLabel ?? resolved.providerId ?? '',
          resolved.slug,
          ms,
        ),
    });
    let lastCancellationCheck = 0;
    const launch = ({
      loop,
      messages,
      ...prepared
    }: Awaited<ReturnType<typeof prepareAttempt>>) => {
      let failed = false;
      const result = streamText({
        model,
        // withProviderRetries retries instead, before any output only.
        maxRetries: 0,
        system: prepared.system,
        messages,
        abortSignal: abortController.signal,
        ...turn.generationSettings,
        ...(sdkTools && loop
          ? {
              tools: sdkTools,
              toolApproval: toolApprovalPolicy(turn.tools),
              stopWhen: loop.stopWhen,
              prepareStep: loop.prepareStep,
              onStepFinish: loop.onStepFinish,
            }
          : {}),
        onChunk: async () => {
          if (Date.now() - lastCancellationCheck < 500) return;
          lastCancellationCheck = Date.now();
          if (await isChatRunCancellationRequested(runIdentity.runId)) {
            abortController.abort(runAbortReason('user-stop'));
          }
        },
        onError: ({ error }) => {
          failed = true;
          logger.error(
            { error, modelSlug: resolved.slug, runId: runIdentity.runId },
            'Model stream failed',
          );
        },
      });
      return {
        ...prepared,
        loop,
        result,
        get failed() {
          return failed;
        },
      };
    };
    const first = await prepareAttempt(uiMessages, system);
    capacity = await admitTurn(turn, run);
    if (capacity.kind === 'admitted') lease = capacity.lease;
    registerLocalChatRun(runIdentity, abortController);
    // A shutdown waits for this reply, and past its limit stops it here.
    untrack = trackRun(runIdentity.runId, abortController);
    let current = lease ? launch(first) : undefined;

    modelStarted = current !== undefined;
    const responseStream = createUIMessageStream({
      originalMessages: uiMessages,
      generateId: () => assistantMessage.id,
      execute: async ({ writer }) => {
        // Attribute the reply while it streams, not only after reloading storage.
        writer.write({
          type: 'start',
          messageMetadata: { modelSlug: resolved.slug, effort: input.effort ?? null },
        });
        // A continued reply already carries its opening parts.
        if (turn.contextLimited && !turn.continuation)
          writer.write({ type: 'data-context-window', data: { limited: true } });
        if (searchGroundingPart) writer.write(searchGroundingPart);
        if (turn.projectSearchPart) writer.write(turn.projectSearchPart);
        for (const source of sourceParts) writer.write(source);
        if (!current && capacity?.kind === 'waiting') {
          const waited = await waitForCapacity(capacity, {
            writer,
            signal: abortController.signal,
            runId: runIdentity.runId,
            model: resolved.displayName,
          });
          if (waited.kind !== 'admitted') {
            unadmitted = waited;
            if (waited.kind === 'timeout')
              writer.write({
                type: 'error',
                errorText: capacityTimeoutMessage(resolved.displayName, waited.waitedMs),
              });
            else if (waited.kind === 'cancelled') writer.write({ type: 'abort' });
            else {
              void recordHandoff(resolved.providerId ?? '', turn.promptMessageId, waited.tag);
              writer.write({ type: 'finish', finishReason: 'other' });
            }
            return;
          }
          lease = waited.lease;
          current = launch(first);
        }
        if (!current) return;
        // The provider refused the input as too long before writing anything:
        // try once more with the oldest turns left out (no summary call; one
        // is queued for later turns). Never more than once.
        if (turn.recoverOverflow && (await overflowedBeforeOutput(current.result))) {
          const recovered = await turn.recoverOverflow().catch((error: unknown) => {
            logger.warn({ error, runId: runIdentity.runId }, 'Overflow recovery failed');
            return null;
          });
          if (recovered && !abortController.signal.aborted) {
            if (recovered.contextLimited && !turn.contextLimited && !turn.continuation)
              writer.write({ type: 'data-context-window', data: { limited: true } });
            current = launch(await prepareAttempt(recovered.uiMessages, recovered.system));
          }
        }
        const { loop } = current;
        const modelStream = current.result.toUIMessageStream({
          originalMessages: current.uiMessages,
          sendStart: false,
          ...(loop ? { onError: toolStreamErrorText } : {}),
        });
        writer.merge(
          loop
            ? modelStream.pipeThrough(
                loop.decorate(turn.continuation?.existingParts ?? [], turn.continuation?.refused),
              )
            : modelStream,
        );
      },
      onEnd: ({ responseMessage, isAborted }) => {
        if (setupFailed) return;
        if (completion) return completion;
        completion = (async () => {
          // A stop is a stop even when the provider's stream ended it with an
          // error rather than an abort frame; a stopped reply is never saved
          // as complete (#136).
          const stopped = isAborted || abortController.signal.aborted;
          const status = unadmitted
            ? unadmitted.kind === 'timeout'
              ? 'error'
              : 'cancelled'
            : stopped
              ? 'cancelled'
              : !current || current.failed
                ? 'error'
                : 'complete';
          const interrupted = stopped && stoppedByShutdown(abortController.signal);
          outcome = {
            status,
            ...(status === 'error' ? { error: 'The model stream failed' } : {}),
          };
          const capacityMessage =
            unadmitted?.kind === 'timeout'
              ? capacityTimeoutMessage(resolved.displayName, unadmitted.waitedMs)
              : unadmitted?.kind === 'handoff'
                ? CAPACITY_HANDOFF_MESSAGE
                : undefined;

          try {
            await persistAssistant(
              turn,
              run,
              responseMessage,
              status,
              async () => {
                const usage = current ? await runUsage(current.result, current.loop, status) : null;
                // The tokens-per-minute estimate becomes what was used.
                await lease?.settle(
                  usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : null,
                );
                return usage;
              },
              interrupted,
              unadmitted ? { errorMessage: capacityMessage } : undefined,
            );
          } catch (error) {
            outcome = { status: 'error', error: 'Assistant message persistence failed' };
            logger.error(
              { error, threadId: thread.id, runId: runIdentity.runId },
              'Failed to persist assistant message',
            );
          } finally {
            // Release on generation end, not response close: clients may disconnect
            // and resume the same run while it continues generating.
            await lease?.release();
            await releaseRunHandles(run);
            observeChatReply(outcome.status, run.startedAt);
            if (interrupted) await recordDrainInterruptedReply();
          }
          // After the claim is released: a reply that took the history past
          // the soft threshold queues a background summary for later turns.
          if (outcome.status === 'complete' && turn.compactionCheck)
            await scheduleCompactionAfterReply({
              threadId: thread.id,
              userId: turn.user.id,
              modelSlug: resolved.slug,
              check: turn.compactionCheck,
              reply: responseMessage,
            });
        })();
        // Done once saved, settled and (when resumable) finalized in Redis.
        void Promise.allSettled([completion, capture]).then(() => untrack?.());
        return completion;
      },
    });

    return createUIMessageStreamResponse({
      stream: responseStream,
      headers: {
        'X-OCI-Chat-Run-Id': runIdentity.runId,
        'X-OCI-Prompt-Message-Id': turn.promptMessageId,
        'X-OCI-Stream-Persistence': persistence === 'available' ? 'redis' : 'unavailable',
      },
      ...(persistence === 'available'
        ? {
            consumeSseStream: ({ stream }: { stream: ReadableStream<string> }) => {
              // The SDK starts this consumer before constructing the Response.
              // Once started it exclusively owns Redis finalization, even if
              // response construction subsequently throws.
              captureStarted = true;
              capture = captureChatRun(runIdentity, stream, () => outcome);
              return capture;
            },
          }
        : {}),
    });
  } catch (error) {
    setupFailed = true;
    outcome = { status: 'error', error: 'Stream setup failed' };
    abortController.abort(runAbortReason('setup-failed'));
    await lease?.release();
    if (capacity?.kind === 'waiting') await capacity.cancel();
    // If SDK completion already began, let its measured usage settle first.
    await completion;
    await failRunSetup(run, { modelStarted, abandon: !captureStarted });
    untrack?.();
    throw error;
  }
}

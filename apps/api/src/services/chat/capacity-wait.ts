import { CAPACITY_PART_ID, CAPACITY_PART_TYPE, type CapacityWaitData } from '@oci/shared';
import type { UIMessageStreamWriter } from 'ai';
import { isChatRunCancellationRequested } from '../chat-streams.js';
import { requestTurnCapacity } from '../limits/capacity/index.js';
import type { CapacityRequest, WaitOutcome } from '../limits/capacity/queue.js';
import { messageCost, textCost } from './context-budget.js';
import type { PreparedTurn } from './prepare-turn.js';
import type { AcquiredRun } from './run-lifecycle.js';

/**
 * A turn waiting for provider capacity (v0.11 design, item 15). The wait
 * happens after the turn is stored and its reply stream has begun, so its
 * position is an event of that stream: a reader who reconnects, on any
 * replica, replays it.
 */

/** Saved on a reply whose replica stopped while it waited; the browser sends it again. */
export const CAPACITY_HANDOFF_MESSAGE =
  'The server restarted before this reply started. Retry to send the message again.';

export function capacityTimeoutMessage(model: string, waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  return `${model} is busy. Your message waited ${minutes === 1 ? 'a minute' : `${minutes} minutes`} without a free place; try again in a few minutes.`;
}

/**
 * Tokens a turn is expected to use, for a tokens-per-minute limit: its input
 * (about three bytes a token, rounded up from the context budget's byte
 * count) and the output it reserves, as providers count it. The reply's
 * reported usage replaces it when it ends.
 */
export function estimatedTurnTokens(
  turn: Pick<PreparedTurn, 'uiMessages' | 'system'> & {
    resolved: { maxOutputTokens: number | null };
  },
): number {
  const units = turn.uiMessages.reduce(
    (sum, message) => sum + messageCost(message).units,
    textCost(turn.system).units,
  );
  return Math.ceil(units / 3) + (turn.resolved.maxOutputTokens ?? 0);
}

export function admitTurn(turn: PreparedTurn, run: AcquiredRun): Promise<CapacityRequest> {
  return requestTurnCapacity({
    runId: run.runIdentity.runId,
    model: turn.resolved,
    user: turn.user,
    tokens: estimatedTurnTokens(turn),
    promptMessageId: turn.input.trigger === 'regenerate-message' ? turn.promptMessageId : null,
  });
}

/** Waits for a queued turn, writing its position to the reply as it changes. */
export async function waitForCapacity(
  request: Extract<CapacityRequest, { kind: 'waiting' }>,
  options: {
    writer: Pick<UIMessageStreamWriter, 'write'>;
    signal: AbortSignal;
    runId: string;
    model: string;
  },
): Promise<WaitOutcome> {
  const write = (data: CapacityWaitData) =>
    options.writer.write({ type: CAPACITY_PART_TYPE, id: CAPACITY_PART_ID, data });
  const seconds = (ms: number) => Math.round(ms / 1000);
  write({
    state: 'waiting',
    model: options.model,
    position: request.first.position,
    estimatedWaitSeconds: request.first.etaSeconds,
    waitedSeconds: 0,
  });
  const outcome = await request.wait({
    signal: options.signal,
    cancelRequested: () => isChatRunCancellationRequested(options.runId),
    onUpdate: (update) =>
      write({
        state: 'waiting',
        model: options.model,
        position: update.position,
        estimatedWaitSeconds: update.etaSeconds,
        waitedSeconds: seconds(update.waitedMs),
      }),
  });
  const waitedSeconds = seconds(
    outcome.kind === 'admitted' ? outcome.lease.waitedMs : outcome.waitedMs,
  );
  if (outcome.kind !== 'cancelled')
    write({
      state:
        outcome.kind === 'admitted'
          ? 'admitted'
          : outcome.kind === 'timeout'
            ? 'timeout'
            : 'handoff',
      model: options.model,
      position: null,
      estimatedWaitSeconds: null,
      waitedSeconds,
    });
  return outcome;
}

import { rateLimited } from '../../lib/errors.js';
import { beginChatRun } from '../chat-streams.js';
import { acquireStreamSlot } from '../limits/concurrency.js';
import { reserveQuotaForRun, settleReservation, type UsageReservation } from '../quota/index.js';
import { failRunSetup, type RunResources } from './run-cleanup.js';
import { claimThread } from './thread-claim.js';
import type { TurnContext } from './turn-context.js';

export type AcquiredRun = RunResources & {
  startedAt: number;
  assistantMessage: { id: string };
  reservation: UsageReservation;
};

/** Acquire durable admission before preparation, independent of Redis availability. */
export async function acquireRun(context: TurnContext): Promise<AcquiredRun> {
  const { user, thread, resolved } = context;
  const startedAt = Date.now();
  const runIdentity: RunResources['runIdentity'] = {
    runId: crypto.randomUUID(),
    threadId: thread.id,
    userId: user.id,
  };
  const streamSlot = await acquireStreamSlot(user.id, user.role, runIdentity.runId);
  if (!streamSlot)
    throw rateLimited(
      'You have too many responses generating at once. Wait for one to finish and try again.',
    );
  const resources: RunResources = {
    runIdentity,
    streamSlot,
    persistence: 'unavailable',
    reservation: null,
    turnPersisted: false,
  };
  try {
    const assistantMessage = await claimThread(context, runIdentity.runId);
    resources.assistantMessage = assistantMessage;
    const persistence = await beginChatRun(runIdentity, { admission: 'durable' });
    // A cache collision cannot veto the durable claim. A racing publication or
    // unusable cache only makes this response non-resumable.
    resources.persistence = persistence === 'available' ? 'available' : 'unavailable';
    // Keep the identity available for cleanup even if a successful reservation
    // commit loses its reply. Prices here are not used for settlement.
    resources.reservation = {
      id: runIdentity.runId,
      userId: user.id,
      modelSlug: resolved.slug,
      pricing: { inputPriceMicros: null, outputPriceMicros: null },
    };
    const reservation = await reserveQuotaForRun({
      userId: user.id,
      role: user.role,
      modelSlug: resolved.slug,
      runId: runIdentity.runId,
    });
    resources.reservation = reservation;
    return { ...resources, startedAt, assistantMessage, reservation };
  } catch (error) {
    await failRunSetup(resources);
    throw error;
  }
}

/** Every admitted run has a durable usage identity, including unlimited runs. */
export async function settleUsage(
  reservation: UsageReservation,
  usage: { inputTokens?: number | null; outputTokens?: number | null; partial?: boolean } | null,
): Promise<void> {
  await settleReservation(
    reservation,
    usage
      ? {
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          ...(usage.partial ? { partial: true } : {}),
        }
      : null,
  );
}

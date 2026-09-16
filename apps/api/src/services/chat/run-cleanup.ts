import { and, eq, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import {
  abandonChatRun,
  type BeginChatRunResult,
  type beginChatRun,
  unregisterLocalChatRun,
} from '../chat-streams.js';
import type { ConcurrencySlot } from '../limits/concurrency.js';
import { releaseReservation, settleReservation, type UsageReservation } from '../quota/index.js';

/** Resources may be only partly acquired when setup fails. */
export interface RunResources {
  runIdentity: Parameters<typeof beginChatRun>[0];
  streamSlot: ConcurrencySlot;
  persistence: BeginChatRunResult;
  assistantMessage?: { id: string };
  reservation: UsageReservation | null;
}

async function attempt(resources: RunResources, operation: string, cleanup: () => Promise<void>) {
  try {
    await cleanup();
  } catch (error) {
    // One unavailable backend must not prevent the other resources being freed,
    // or replace the original quota/validation/SDK error returned to the caller.
    logger.error(
      { error, operation, runId: resources.runIdentity.runId },
      'Chat run cleanup failed',
    );
  }
}

/** Safe on repeat calls; release only handles owned by this run. */
export async function releaseRunHandles(resources: RunResources, abandon = false): Promise<void> {
  unregisterLocalChatRun(resources.runIdentity.runId);
  await Promise.all([
    attempt(resources, 'stream slot', () => resources.streamSlot.release()),
    ...(abandon && resources.persistence === 'available'
      ? [attempt(resources, 'run lock', () => abandonChatRun(resources.runIdentity))]
      : []),
  ]);
}

/**
 * Setup has no response consumer to finish the run. Mark only our streaming row
 * failed and release pending allowance when the SDK never started. If the SDK
 * already returned a stream, count the failed attempt (like cancellation), not
 * a free generation. Unknown token usage settles at zero, as in normal failure.
 */
export async function failRunSetup(
  resources: RunResources,
  { modelStarted = false, abandon = true }: { modelStarted?: boolean; abandon?: boolean } = {},
): Promise<void> {
  await Promise.all([
    releaseRunHandles(resources, abandon),
    attempt(resources, 'assistant row', async () => {
      if (!resources.assistantMessage) return;
      await db
        .update(schema.message)
        .set({
          status: 'error',
          errorMessage: 'The response could not be started. Please try again.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.message.id, resources.assistantMessage.id),
            eq(schema.message.threadId, resources.runIdentity.threadId),
            eq(schema.message.userId, resources.runIdentity.userId),
            eq(schema.message.status, 'streaming'),
          ),
        );
    }),
    attempt(resources, 'quota reservation', async () => {
      if (!resources.reservation) return;
      if (modelStarted) await settleReservation(resources.reservation, null);
      else await releaseReservation(resources.reservation);
    }),
  ]);
}

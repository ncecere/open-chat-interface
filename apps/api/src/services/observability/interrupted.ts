import { logger } from '../../lib/logger.js';
import { sharedRedisClient } from '../chat-streams.js';
import { observeDrainInterruptedReply } from './events.js';

/**
 * Cluster-wide count of replies saved as interrupted by a drain, kept in
 * Redis and exported by every replica as
 * `oci_cluster_drain_interrupted_replies_total` (operational.ts).
 */
export const INTERRUPTED_KEY = 'oci:metrics:drain-interrupted-replies';

/**
 * A reply was saved as interrupted because its replica's drain limit ran
 * out. Counted in this process and in Redis: the process exits seconds
 * later, usually before Prometheus scrapes it again, so the per-process
 * counter alone would rarely be seen.
 */
export async function recordDrainInterruptedReply(): Promise<void> {
  observeDrainInterruptedReply();
  try {
    const redis = await sharedRedisClient();
    await redis?.incr(INTERRUPTED_KEY);
  } catch (error) {
    logger.debug({ err: String(error) }, 'Could not count an interrupted reply in Redis');
  }
}

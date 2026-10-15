import { ERROR_CODES, GROUP_ERROR_REASONS, MESSAGE_UPGRADE_IN_PROGRESS } from '@oci/shared';
import { AppError } from '../../lib/errors.js';
import { APP_VERSION } from '../../version.js';
import { liveReplicas } from '../jobs/workers.js';

const minorOf = (version: string): [number, number] | null => {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : null;
};

/** True when `version` is an earlier minor release (0.13.4 is earlier than 0.14.0; 0.14.0 is not earlier than 0.14.2). */
export function isOlderMinor(version: string, than: string = APP_VERSION): boolean {
  const a = minorOf(version);
  const b = minorOf(than);
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/**
 * Refuses (409) while a replica of an earlier minor release is still serving.
 *
 * Groups, group grants and project shares are written only by this release:
 * an older replica knows nothing of them, so budgets granted to a group would
 * not be enforced there and a shared project would be invisible. Creating
 * them waits for the rolling upgrade to finish. Without Redis there are no
 * heartbeats, which is also the case where only one replica is supported.
 *
 * Used by the group grants route and by project sharing.
 */
export async function assertNoOlderReplicas(): Promise<void> {
  const replicas = await liveReplicas().catch(() => null);
  if (!replicas?.some((replica) => isOlderMinor(replica.version))) return;
  throw new AppError(ERROR_CODES.CONFLICT, MESSAGE_UPGRADE_IN_PROGRESS, 409, {
    reason: GROUP_ERROR_REASONS.UPGRADE_IN_PROGRESS,
  });
}

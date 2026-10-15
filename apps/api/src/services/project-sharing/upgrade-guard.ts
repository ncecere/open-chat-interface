import { conflict } from '../../lib/errors.js';
import { APP_VERSION } from '../../version.js';
import { liveReplicas } from '../jobs/workers.js';

/**
 * The mixed-version guard (v0.14, project sharing and group grants).
 *
 * While a replica of an older release still serves, a share created now would be
 * invisible to it: it would answer 404 for a recipient (safe), but it would also
 * delete an editor's account without handing their files to the owners (data
 * loss). So creating a share, transferring a project, or changing a group's
 * grants answers 409 "An upgrade is still in progress" while any live replica
 * heartbeat reports an older version. Changing or removing what already exists
 * is allowed, as are reads: they cannot create the exposure.
 *
 * What the evidence can and cannot say:
 * - Without Redis (supported for one replica) there are no heartbeats: this
 *   replica is the only one (more than one already requires Redis), so nothing
 *   is older. `liveReplicas()` returns null and the answer is "go".
 * - With Redis, a replica is live if it heartbeat in the last minute. A replica
 *   that stopped is not counted once its heartbeat expires.
 * - Redis configured but unreachable: no evidence, so "go". An outage must not
 *   turn into a block on sharing; the documented upgrade note covers the window.
 */
export const UPGRADE_IN_PROGRESS_MESSAGE =
  'An upgrade is still in progress. Try again when it has finished.';

/** Numeric parts of a release such as `0.14.0` or `v0.13.1-rc1`; null when it is not one. */
function parts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * True when `other` is an older release than `current`. A version that cannot be
 * read as a release, and differs, counts as older: if the guard cannot tell,
 * it does not let a share through.
 */
export function isOlderRelease(other: string, current: string): boolean {
  if (other === current) return false;
  const a = parts(other);
  const b = parts(current);
  if (!a || !b) return true;
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]!;
  }
  return false;
}

export async function assertNoOlderReplica(
  replicas: () => Promise<Array<{ version: string }> | null> = liveReplicas,
  current: string = APP_VERSION,
): Promise<void> {
  const live = await replicas().catch(() => null);
  if (!live) return;
  if (live.some((replica) => isOlderRelease(replica.version, current))) {
    throw conflict(UPGRADE_IN_PROGRESS_MESSAGE, { reason: 'upgrade_in_progress' });
  }
}

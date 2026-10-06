import { isPostStepDone } from '../migrations/readiness.js';

/**
 * Code artifacts (#298) are made only once every replica and web proxy runs
 * this release. The previous release's web app draws an artifact card with an
 * icon looked up by kind, and an unknown kind leaves it no icon to draw, so a
 * code artifact made during a rolling upgrade would break the conversation for
 * anyone still on it. Post-deploy steps run after every replica and proxy is
 * replaced (docs/dev/rolling-upgrades.md); this one validates the widened kind
 * check (packages/db/post), and its finishing is the signal. Until then code
 * stays in the reply, as it did before.
 */
export const CODE_ARTIFACTS_STEP = '0009_artifact_kind_code';

/** Whether code artifacts may be made; not ready when the database cannot say. */
export async function codeArtifactsReady(): Promise<boolean> {
  try {
    return await isPostStepDone(CODE_ARTIFACTS_STEP);
  } catch {
    return false;
  }
}

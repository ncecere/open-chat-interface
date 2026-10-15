import {
  CLASSIFICATION_MODES,
  CLASSIFICATION_SERVICES,
  type ClassificationMode,
  type ClassificationService,
  type ClassificationSettings,
} from '@oci/shared';
import { getSetting } from '../settings.js';

/**
 * The `classification` instance setting, normalised: an absent or unreadable
 * value is `off` with no approvals, so nothing changes until an administrator
 * turns it on (and a stored value from the future is never trusted to mean
 * more than it can).
 */
export function normalizeClassificationSettings(
  stored: Awaited<ReturnType<typeof getSetting<'classification'>>> | null | undefined,
): ClassificationSettings {
  const mode = CLASSIFICATION_MODES.includes(stored?.mode as ClassificationMode)
    ? (stored?.mode as ClassificationMode)
    : 'off';
  const services = Object.fromEntries(
    CLASSIFICATION_SERVICES.map((name) => {
      const ids = stored?.services?.[name];
      return [name, Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []];
    }),
  ) as Record<ClassificationService, string[]>;
  return { mode, services };
}

/** Read through the settings cache: Redis invalidation is immediate, otherwise at most 30 s. */
export async function classificationSettings(): Promise<ClassificationSettings> {
  return normalizeClassificationSettings(await getSetting('classification'));
}

/** Just the mode, for the paths that only need to know whether to look at anything else. */
export async function classificationMode(): Promise<ClassificationMode> {
  return (await classificationSettings()).mode;
}

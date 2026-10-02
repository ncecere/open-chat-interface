import { REASONING_EFFORTS, type ReasoningEffort, USER_ROLES, type UserRole } from './constants.js';

/** Chat features an administrator can switch on or off for one role. */
export const ROLE_FEATURE_KEYS = [
  'webSearch',
  'attachments',
  'shareLinks',
  'temporaryChat',
  'branching',
  'projects',
  'memory',
  'artifacts',
] as const;
export type RoleFeatureKey = (typeof ROLE_FEATURE_KEYS)[number];

/**
 * What one role may use, before instance-wide switches are applied. A feature
 * is available to someone only when both the instance and their role allow it.
 */
export type RoleFeatures = Record<RoleFeatureKey, boolean> & {
  /** Always includes `instant`, in `REASONING_EFFORTS` order. */
  reasoningEfforts: ReasoningEffort[];
};

const ALL_FEATURES: RoleFeatures = {
  webSearch: true,
  attachments: true,
  shareLinks: true,
  temporaryChat: true,
  branching: true,
  projects: true,
  memory: true,
  artifacts: true,
  reasoningEfforts: [...REASONING_EFFORTS],
};

/**
 * Built-in values, matching the rules that were fixed in code before they were
 * configurable: restricted accounts cannot upload, share or start temporary
 * chats; every other role can use everything the instance offers. Projects
 * arrived later and follow the same line: off for restricted accounts until an
 * administrator turns them on. So do user memory and artifacts (v0.9); user
 * memory is also off instance-wide until an administrator turns it on.
 */
export const DEFAULT_ROLE_FEATURES: Record<UserRole, RoleFeatures> = Object.fromEntries(
  USER_ROLES.map((role) => [
    role,
    role === 'restricted'
      ? {
          ...ALL_FEATURES,
          attachments: false,
          shareLinks: false,
          temporaryChat: false,
          projects: false,
          memory: false,
          artifacts: false,
          reasoningEfforts: [...REASONING_EFFORTS],
        }
      : { ...ALL_FEATURES, reasoningEfforts: [...REASONING_EFFORTS] },
  ]),
) as Record<UserRole, RoleFeatures>;

/**
 * Puts allowed levels in canonical order, drops unknown or repeated values and
 * always keeps `instant`: switching reasoning off can never be withheld.
 */
export function normalizeReasoningEfforts(efforts: readonly unknown[]): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((effort) => effort === 'instant' || efforts.includes(effort));
}

/** The levels a model offers that a role is also allowed to choose. */
export function intersectReasoningEfforts(
  modelEfforts: readonly ReasoningEffort[],
  roleEfforts: readonly ReasoningEffort[],
): ReasoningEffort[] {
  return modelEfforts.filter((effort) => roleEfforts.includes(effort));
}

/**
 * The level a new conversation starts at: the administrator's default when the
 * model and role allow it, otherwise `instant`, otherwise the lowest offered.
 */
export function clampReasoningEffort(
  preferred: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  if (supported.length === 0) return 'instant';
  if (supported.includes(preferred)) return preferred;
  return supported.includes('instant') ? 'instant' : (supported[0] ?? 'instant');
}

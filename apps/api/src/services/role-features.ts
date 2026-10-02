import {
  DEFAULT_ROLE_FEATURES,
  normalizeReasoningEfforts,
  ROLE_FEATURE_KEYS,
  type RoleFeatureKey,
  type RoleFeatures,
  type UpdateRoleFeaturesInput,
  type UserRole,
} from '@oci/shared';
import { forbidden } from '../lib/errors.js';
import { webSearchProblem } from './search/availability.js';
import {
  type FeatureSettings,
  getSetting,
  type SearchSettings,
  type StoredRoleFeatureSettings,
  updateSetting,
} from './settings.js';

/** Features as one person experiences them: instance switch AND role switch. */
type EffectiveFeatures = Record<RoleFeatureKey, boolean> & Pick<RoleFeatures, 'reasoningEfforts'>;

/** Wording shared by every check that refuses a feature because of the role. */
const ROLE_FEATURE_DENIED: Record<RoleFeatureKey, string> = {
  webSearch: 'Web search is not available for your role',
  attachments: 'Attachments are not available for your role',
  shareLinks: 'Public share links are not available for your role',
  temporaryChat: 'Temporary chats are not available for your role',
  branching: 'Branching is not available for your role',
  projects: 'Projects are not available for your role',
};

/**
 * One role's switches from stored overrides, falling back field by field to
 * the built-in defaults. Pure so the precedence can be tested without a
 * database. An unknown role (never expected) gets the restricted defaults,
 * matching how the auth middleware treats one.
 */
export function resolveRoleFeatures(
  role: UserRole,
  stored: StoredRoleFeatureSettings | undefined,
): RoleFeatures {
  const defaults = DEFAULT_ROLE_FEATURES[role] ?? DEFAULT_ROLE_FEATURES.restricted;
  const saved = stored?.roles?.[role] ?? {};
  const switches = Object.fromEntries(
    ROLE_FEATURE_KEYS.map((key) => [
      key,
      typeof saved[key] === 'boolean' ? saved[key] : defaults[key],
    ]),
  ) as Record<RoleFeatureKey, boolean>;

  return {
    ...switches,
    reasoningEfforts: Array.isArray(saved.reasoningEfforts)
      ? normalizeReasoningEfforts(saved.reasoningEfforts)
      : [...defaults.reasoningEfforts],
  };
}

/**
 * Combines the instance switches with a role's. Web search additionally needs
 * a provider that can actually run, so the composer never offers a search
 * that would fail. Projects have no instance-wide switch: the role decides.
 */
export function combineFeatures(
  instance: Partial<FeatureSettings>,
  search: SearchSettings,
  role: RoleFeatures,
): EffectiveFeatures {
  return {
    webSearch:
      role.webSearch &&
      webSearchProblem({ webSearch: Boolean(instance.webSearch) }, search) === null,
    attachments: role.attachments && Boolean(instance.attachments),
    shareLinks: role.shareLinks && Boolean(instance.shareLinks),
    temporaryChat: role.temporaryChat && Boolean(instance.temporaryChat),
    branching: role.branching && Boolean(instance.branching),
    projects: role.projects,
    reasoningEfforts: [...role.reasoningEfforts],
  };
}

/** The role's own switches; the single source every role check reads. */
export async function roleFeatures(role: UserRole): Promise<RoleFeatures> {
  return resolveRoleFeatures(role, await getSetting('roleFeatures'));
}

/**
 * Refuses a feature the role does not allow. Callers check the instance-wide
 * switch afterwards with their own wording, so a role refusal (403) is
 * reported ahead of an instance one, as before roles were configurable.
 */
export async function assertRoleFeature(role: UserRole, feature: RoleFeatureKey): Promise<void> {
  const own = await roleFeatures(role);
  if (!own[feature]) throw forbidden(ROLE_FEATURE_DENIED[feature]);
}

/**
 * Saves only the sent fields for one role, leaving other roles and unsent
 * fields on whatever they were (including inherited defaults).
 */
export async function updateRoleFeatures(
  role: UserRole,
  patch: UpdateRoleFeaturesInput,
): Promise<RoleFeatures> {
  const current = await getSetting('roleFeatures');
  const roles = { ...current.roles };
  const next: Partial<RoleFeatures> = { ...roles[role] };

  for (const key of ROLE_FEATURE_KEYS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  if (patch.reasoningEfforts !== undefined) {
    next.reasoningEfforts = normalizeReasoningEfforts(patch.reasoningEfforts);
  }

  roles[role] = next;
  await updateSetting('roleFeatures', { roles });
  return roleFeatures(role);
}

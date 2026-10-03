import {
  type CatalogModel,
  effectiveSupportedEfforts,
  type PersonalDefaultProblem,
  type ReasoningEffort,
} from '@oci/shared';
import { validationFailed } from '../lib/errors.js';

/**
 * A person's own starting model and reasoning level (Settings → Models, v0.10).
 *
 * The composer starts from an explicit choice in the conversation, then these,
 * then the instance defaults. They are checked against what the role allows
 * when saved and again whenever they are read, because an administrator can
 * hide a model or withdraw a level afterwards: a default that no longer
 * applies is ignored (the instance default is used) and reported, so
 * Settings can say so. Nothing is rewritten in the database.
 */
export interface SavedDefaults {
  defaultModelSlug: string | null;
  defaultEffort: ReasoningEffort | null;
}

export interface ResolvedDefaults {
  /** The person's model when it is still available to them, otherwise null. */
  modelSlug: string | null;
  /** Where the composer's level starts, before clamping to the chosen model. */
  effort: ReasoningEffort;
  /** Saved defaults that no longer apply. */
  problems: PersonalDefaultProblem[];
}

const LEVEL_NAMES: Record<ReasoningEffort, string> = {
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Instant is always allowed: choosing no reasoning can never be withheld. */
function modelOffers(model: CatalogModel, effort: ReasoningEffort): boolean {
  return effort === 'instant' || effectiveSupportedEfforts(model).includes(effort);
}

/**
 * Which saved defaults apply. `catalog` is the role's catalog (levels already
 * narrowed to the role); it may be omitted when no model is saved.
 */
export function resolvePersonalDefaults(
  saved: SavedDefaults,
  context: {
    catalog: readonly CatalogModel[] | null;
    roleEfforts: readonly ReasoningEffort[];
    instanceEffort: ReasoningEffort;
  },
): ResolvedDefaults {
  const problems: PersonalDefaultProblem[] = [];
  const model = saved.defaultModelSlug
    ? context.catalog?.find((candidate) => candidate.slug === saved.defaultModelSlug)
    : undefined;
  if (saved.defaultModelSlug && !model) problems.push('model');

  let effort = context.instanceEffort;
  if (saved.defaultEffort) {
    const allowed =
      context.roleEfforts.includes(saved.defaultEffort) &&
      (!model || modelOffers(model, saved.defaultEffort));
    if (allowed) effort = saved.defaultEffort;
    else problems.push('effort');
  }
  return { modelSlug: model?.slug ?? null, effort, problems };
}

/**
 * Refuses a change that the role does not allow (422). Only changed fields are
 * checked on their own, so saving a level is not refused because a model saved
 * earlier has since been hidden; the pair is checked when either changes and
 * the model is available.
 */
export function assertPersonalDefaultsAllowed(
  change: Partial<SavedDefaults>,
  next: SavedDefaults,
  context: { catalog: readonly CatalogModel[]; roleEfforts: readonly ReasoningEffort[] },
): void {
  const model = next.defaultModelSlug
    ? context.catalog.find((candidate) => candidate.slug === next.defaultModelSlug)
    : undefined;
  if (change.defaultModelSlug && !model) {
    throw validationFailed('That model is not available to your role.');
  }
  if (change.defaultEffort && !context.roleEfforts.includes(change.defaultEffort)) {
    throw validationFailed(
      `The ${LEVEL_NAMES[change.defaultEffort]} reasoning level is not available to your role.`,
    );
  }
  const changed = change.defaultModelSlug !== undefined || change.defaultEffort !== undefined;
  if (changed && model && next.defaultEffort && !modelOffers(model, next.defaultEffort)) {
    throw validationFailed(
      `${model.displayName} does not offer the ${LEVEL_NAMES[next.defaultEffort]} reasoning level.`,
    );
  }
}

import { and, asc, eq, inArray, schema } from '@oci/db';
import {
  type CatalogModel,
  effectiveSupportedEfforts,
  intersectReasoningEfforts,
  type ProviderKind,
  type ReasoningEffort,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { forbidden, notFound, providerError } from '../lib/errors.js';
import { createLanguageModel, type ProviderCredentials } from './providers/registry.js';
import { roleFeatures } from './role-features.js';

/**
 * Levels a model offers that the role may also choose, so the picker and chat
 * validation agree. Without any, effort control is dropped from the reported
 * capabilities too: clients read a bare `effort_control` with no levels as
 * "every level", which would offer ones the role cannot use.
 */
function effortsForRole(
  model: { capabilities: string[]; supportedEfforts: ReasoningEffort[] },
  roleEfforts: readonly ReasoningEffort[],
) {
  const supportedEfforts = intersectReasoningEfforts(effectiveSupportedEfforts(model), roleEfforts);
  return {
    supportedEfforts,
    capabilities:
      supportedEfforts.length > 0
        ? model.capabilities
        : model.capabilities.filter((capability) => capability !== 'effort_control'),
  };
}

/** Who is choosing a model: their role and their groups (found by `userId`) decide what they may use. */
export interface ModelViewer {
  userId: string;
  role: UserRole;
}

/**
 * The models any group the person is in grants (v0.14, #394), read on every
 * call and never cached: removing someone from a group takes the models away
 * on their next request. A group only adds; this never narrows what the role
 * allows.
 */
async function groupGrantedModelIds(userId: string, among?: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ modelId: schema.modelGroupAccess.modelId })
    .from(schema.modelGroupAccess)
    .innerJoin(schema.groupMember, eq(schema.groupMember.groupId, schema.modelGroupAccess.groupId))
    .where(
      and(
        eq(schema.groupMember.userId, userId),
        among ? inArray(schema.modelGroupAccess.modelId, among) : undefined,
      ),
    );
  return new Set(rows.map((row) => row.modelId));
}

/** Models the person may select (their role's, plus those their groups grant), ordered for the picker. */
export async function listAvailableModels(viewer: ModelViewer): Promise<CatalogModel[]> {
  const { role } = viewer;
  const { reasoningEfforts } = await roleFeatures(role);
  const [rows, viaGroups] = await Promise.all([
    db
      .select({ model: schema.model, provider: schema.provider })
      .from(schema.model)
      .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
      .where(and(eq(schema.model.enabled, true), eq(schema.provider.enabled, true)))
      .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName)),
    groupGrantedModelIds(viewer.userId),
  ]);

  return rows
    .filter(({ model }) => model.visibleToRoles.includes(role) || viaGroups.has(model.id))
    .map(({ model, provider }) => {
      const efforts = effortsForRole(model, reasoningEfforts);
      return {
        id: model.id,
        slug: model.slug,
        displayName: model.displayName,
        description: model.description,
        providerId: model.providerId,
        providerKind: provider.kind,
        providerLabel: provider.label,
        upstreamModelId: model.upstreamModelId,
        capabilities: efforts.capabilities as CatalogModel['capabilities'],
        labId: model.labId,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        supportedEfforts: efforts.supportedEfforts,
        isDefault: model.isDefault,
        sortOrder: model.sortOrder,
      };
    });
}

/**
 * Whether anyone could chat at all: an enabled model on an enabled provider.
 * A person whose role sees none of them is told their role has no models,
 * not that the instance has none (#303).
 */
export async function hasUsableModels(): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.model.id })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(and(eq(schema.model.enabled, true), eq(schema.provider.enabled, true)))
    .limit(1);
  return Boolean(row);
}

interface ResolvedModel {
  /** Catalog and provider ids, for provider capacity (v0.11). */
  modelId?: string;
  providerId?: string;
  providerLabel?: string;
  contextWindow: number | null;
  languageModel: ReturnType<typeof createLanguageModel>;
  slug: string;
  displayName: string;
  maxOutputTokens: number | null;
  capabilities: string[];
  providerKind: ProviderKind;
  supportedEfforts: ReasoningEffort[];
}

/**
 * Resolves a catalog slug to a ready language model, enforcing that the model
 * is enabled and visible to the caller: to their role, or to a group they are
 * in. Client input never reaches the provider as a raw model ID.
 */
export async function resolveModelForRole(
  slug: string,
  viewer: ModelViewer,
): Promise<ResolvedModel> {
  const { role } = viewer;
  const [row] = await db
    .select({ model: schema.model, provider: schema.provider })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(eq(schema.model.slug, slug))
    .limit(1);

  if (!row) throw notFound('That model is not available');
  if (!row.model.enabled || !row.provider.enabled) {
    throw forbidden('That model is currently disabled');
  }
  // The group lookup is made only when the role alone does not allow it.
  if (
    !row.model.visibleToRoles.includes(role) &&
    !(await groupGrantedModelIds(viewer.userId, [row.model.id])).has(row.model.id)
  ) {
    throw forbidden('You do not have access to that model');
  }
  const { reasoningEfforts } = await roleFeatures(role);

  const credentials: ProviderCredentials = {
    kind: row.provider.kind,
    label: row.provider.label,
    apiKey: row.provider.encryptedApiKey ? decryptSecret(row.provider.encryptedApiKey) : null,
    baseUrl: row.provider.baseUrl,
  };

  if (!credentials.apiKey && credentials.kind !== 'openai-compatible') {
    throw providerError(`${row.provider.label} has no API key configured`);
  }

  return {
    modelId: row.model.id,
    providerId: row.provider.id,
    providerLabel: row.provider.label,
    contextWindow: row.model.contextWindow,
    languageModel: createLanguageModel(credentials, row.model.upstreamModelId),
    slug: row.model.slug,
    displayName: row.model.displayName,
    maxOutputTokens: row.model.maxOutputTokens,
    capabilities: row.model.capabilities,
    providerKind: row.provider.kind,
    supportedEfforts: effortsForRole(row.model, reasoningEfforts).supportedEfforts,
  };
}

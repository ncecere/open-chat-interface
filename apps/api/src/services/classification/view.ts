import { inArray, schema } from '@oci/db';
import type {
  ClassificationClass,
  ClassificationMode,
  ClassificationModel,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { listAvailableModels, type ModelViewer } from '../models.js';
import type { ResolvedClass } from './resolve.js';

/** A class as the chips and settings show it. */
export function toClassificationClass(entry: ResolvedClass): ClassificationClass {
  return {
    id: entry.id,
    name: entry.name,
    reasons: entry.reasons,
    locked: entry.locked,
    removable: entry.reasons.includes('person'),
    retired: entry.retired,
    ...(entry.connectorNames.length && { connectorNames: entry.connectorNames }),
    ...(entry.origins.length && { origins: entry.origins }),
  };
}

/** Class ids each of these models is approved for. */
async function approvalsByModel(modelIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const approvals = new Map<string, Set<string>>();
  if (modelIds.length === 0) return approvals;
  const rows = await db
    .select({ modelId: schema.modelDataClass.modelId, id: schema.modelDataClass.dataClassId })
    .from(schema.modelDataClass)
    .where(inArray(schema.modelDataClass.modelId, [...modelIds]));
  for (const row of rows) {
    const set = approvals.get(row.modelId) ?? new Set<string>();
    set.add(row.id);
    approvals.set(row.modelId, set);
  }
  return approvals;
}

/**
 * Each model the role can pick, and whether it may take a conversation that
 * carries `classes`: computed here so no client does set arithmetic. A model
 * is approved for nothing until an administrator says otherwise.
 */
export async function modelStatuses(
  viewer: ModelViewer,
  classes: readonly ResolvedClass[],
  mode: ClassificationMode,
): Promise<ClassificationModel[]> {
  const models = await listAvailableModels(viewer);
  const approvals = await approvalsByModel(models.map((model) => model.id));
  return models.map((model) => {
    const approved = approvals.get(model.id) ?? new Set<string>();
    const missing = classes.filter((entry) => !approved.has(entry.id));
    return {
      slug: model.slug,
      displayName: model.displayName,
      status: missing.length === 0 ? 'ok' : mode === 'block' ? 'blocked' : 'warn',
      missing: missing.map(({ id, name }) => ({ id, name })),
    };
  });
}

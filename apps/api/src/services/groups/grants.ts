import { and, eq, inArray, notInArray, schema } from '@oci/db';
import { GROUP_ERROR_REASONS, type GroupGrants, type PutGroupGrantsInput } from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound, validationFailed } from '../../lib/errors.js';
import { recordAudit } from '../audit.js';
import { getDefaultOrganizationId } from '../organization.js';
import { getGroupGrants } from './groups.js';
import type { GroupActor } from './membership.js';
import { assertNoOlderReplicas } from './upgrade-guard.js';

const sorted = (values: string[]) => [...values].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/**
 * Replaces the budgets and models a group grants (administrators). The only
 * way grants are written: never through the budget or model forms, whose
 * bodies a client may send without a group field and so wipe it.
 *
 * Both lists are applied as a difference (rows that stay keep their id), in one
 * transaction with the group row locked. An id that is not a budget or model of
 * this instance refuses the whole request. Refused while a replica of an
 * earlier release still serves: it would not enforce a group budget (it fails
 * open) or offer a group's models.
 */
export async function putGroupGrants(
  actor: GroupActor,
  groupId: string,
  input: PutGroupGrantsInput,
): Promise<GroupGrants> {
  await assertNoOlderReplicas();
  const organizationId = await getDefaultOrganizationId();

  const outcome = await db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: schema.group.id, name: schema.group.name })
      .from(schema.group)
      .where(eq(schema.group.id, groupId))
      .for('update');
    if (!group) throw notFound('Group not found');

    const [knownPolicies, knownModels] = await Promise.all([
      input.policyIds.length
        ? tx
            .select({ id: schema.quotaPolicy.id })
            .from(schema.quotaPolicy)
            .where(
              and(
                eq(schema.quotaPolicy.organizationId, organizationId),
                inArray(schema.quotaPolicy.id, input.policyIds),
              ),
            )
        : [],
      input.modelIds.length
        ? tx
            .select({ id: schema.model.id })
            .from(schema.model)
            .where(
              and(
                eq(schema.model.organizationId, organizationId),
                inArray(schema.model.id, input.modelIds),
              ),
            )
        : [],
    ]);
    const unknown = [
      ...input.policyIds.filter((id) => !knownPolicies.some((row) => row.id === id)),
      ...input.modelIds.filter((id) => !knownModels.some((row) => row.id === id)),
    ];
    if (unknown.length > 0) {
      throw validationFailed(
        'Some of the budgets or models do not exist. Reload the page and try again.',
        { reason: GROUP_ERROR_REASONS.UNKNOWN_GRANT, ids: unknown },
      );
    }

    const [policyRows, modelRows] = await Promise.all([
      tx
        .select({ id: schema.quotaPolicyGroup.policyId })
        .from(schema.quotaPolicyGroup)
        .where(eq(schema.quotaPolicyGroup.groupId, groupId)),
      tx
        .select({ id: schema.modelGroupAccess.modelId })
        .from(schema.modelGroupAccess)
        .where(eq(schema.modelGroupAccess.groupId, groupId)),
    ]);
    const before = {
      policyIds: sorted(policyRows.map((row) => row.id)),
      modelIds: sorted(modelRows.map((row) => row.id)),
    };
    const after = { policyIds: sorted(input.policyIds), modelIds: sorted(input.modelIds) };

    if (!same(before.policyIds, after.policyIds)) {
      await tx
        .delete(schema.quotaPolicyGroup)
        .where(
          and(
            eq(schema.quotaPolicyGroup.groupId, groupId),
            after.policyIds.length
              ? notInArray(schema.quotaPolicyGroup.policyId, after.policyIds)
              : undefined,
          ),
        );
      const added = after.policyIds.filter((id) => !before.policyIds.includes(id));
      if (added.length) {
        await tx
          .insert(schema.quotaPolicyGroup)
          .values(added.map((policyId) => ({ policyId, groupId })));
      }
    }
    if (!same(before.modelIds, after.modelIds)) {
      await tx
        .delete(schema.modelGroupAccess)
        .where(
          and(
            eq(schema.modelGroupAccess.groupId, groupId),
            after.modelIds.length
              ? notInArray(schema.modelGroupAccess.modelId, after.modelIds)
              : undefined,
          ),
        );
      const added = after.modelIds.filter((id) => !before.modelIds.includes(id));
      if (added.length) {
        await tx
          .insert(schema.modelGroupAccess)
          .values(added.map((modelId) => ({ modelId, groupId })));
      }
    }
    return { group, before, after };
  });

  if (
    !same(outcome.before.policyIds, outcome.after.policyIds) ||
    !same(outcome.before.modelIds, outcome.after.modelIds)
  ) {
    await recordAudit({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'group.grants.update',
      targetType: 'group',
      targetId: groupId,
      metadata: {
        groupName: outcome.group.name,
        policyIds: { before: outcome.before.policyIds, after: outcome.after.policyIds },
        modelIds: { before: outcome.before.modelIds, after: outcome.after.modelIds },
      },
    });
  }
  return getGroupGrants(groupId);
}

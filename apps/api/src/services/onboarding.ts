import { and, desc, eq, isNotNull, schema, sql } from '@oci/db';
import type { OnboardingState, UsagePolicy } from '@oci/shared';
import { db } from '../db/index.js';
import { validationFailed } from '../lib/errors.js';
import { getDefaultOrganizationId } from './organization.js';

/** The policy currently in force, or null when none has been published. */
export async function currentPolicy() {
  const organizationId = await getDefaultOrganizationId();

  const [policy] = await db
    .select()
    .from(schema.usagePolicy)
    .where(
      and(
        eq(schema.usagePolicy.organizationId, organizationId),
        isNotNull(schema.usagePolicy.publishedAt),
      ),
    )
    .orderBy(desc(schema.usagePolicy.version))
    .limit(1);

  return policy ?? null;
}

/**
 * What must happen before a person can use the instance.
 *
 * Acceptance is checked against the exact policy version rather than a flag,
 * so publishing a new version re-prompts everyone automatically: nobody has
 * accepted a version that did not exist when they last signed in.
 */
export async function onboardingStateFor(userId: string): Promise<OnboardingState> {
  const policy = await currentPolicy();

  const [preference] = await db
    .select({ onboardedAt: schema.userPreference.onboardedAt })
    .from(schema.userPreference)
    .where(eq(schema.userPreference.userId, userId))
    .limit(1);

  if (!policy) {
    return { pendingPolicy: null, needsIntroduction: !preference?.onboardedAt };
  }

  const [accepted] = await db
    .select({ id: schema.usagePolicyAcceptance.id })
    .from(schema.usagePolicyAcceptance)
    .where(
      and(
        eq(schema.usagePolicyAcceptance.policyId, policy.id),
        eq(schema.usagePolicyAcceptance.userId, userId),
      ),
    )
    .limit(1);

  if (accepted) {
    return { pendingPolicy: null, needsIntroduction: !preference?.onboardedAt };
  }

  // Someone who accepted an earlier version is being asked again because the
  // text changed, which is worth saying rather than presenting it as new.
  const [previous] = await db
    .select({ id: schema.usagePolicyAcceptance.id })
    .from(schema.usagePolicyAcceptance)
    .where(eq(schema.usagePolicyAcceptance.userId, userId))
    .limit(1);

  return {
    pendingPolicy: {
      id: policy.id,
      version: policy.version,
      title: policy.title,
      body: policy.body,
      isUpdate: Boolean(previous),
    },
    needsIntroduction: !preference?.onboardedAt,
  };
}

/**
 * Records an acceptance.
 *
 * Only the policy in force can be accepted: allowing an older version would
 * let a client keep agreeing to text that has since been replaced. The version
 * is snapshotted so the record survives any later renumbering.
 */
export async function acceptPolicy(params: {
  userId: string;
  policyId: string;
  ipAddress: string | null;
}): Promise<void> {
  const policy = await currentPolicy();
  if (!policy || policy.id !== params.policyId) {
    throw validationFailed('That policy is no longer the current one. Reload and try again.');
  }

  await db
    .insert(schema.usagePolicyAcceptance)
    .values({
      policyId: policy.id,
      userId: params.userId,
      policyVersion: policy.version,
      ipAddress: params.ipAddress,
    })
    .onConflictDoNothing();
}

export async function listPolicies(): Promise<UsagePolicy[]> {
  const organizationId = await getDefaultOrganizationId();

  const rows = await db
    .select({
      id: schema.usagePolicy.id,
      version: schema.usagePolicy.version,
      title: schema.usagePolicy.title,
      body: schema.usagePolicy.body,
      publishedAt: schema.usagePolicy.publishedAt,
      createdAt: schema.usagePolicy.createdAt,
      acceptanceCount: sql<number>`(select count(*) from ${schema.usagePolicyAcceptance}
        where ${schema.usagePolicyAcceptance.policyId} = ${schema.usagePolicy.id})::int`,
    })
    .from(schema.usagePolicy)
    .where(eq(schema.usagePolicy.organizationId, organizationId))
    .orderBy(desc(schema.usagePolicy.version))
    .limit(50);

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    title: row.title,
    body: row.body,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    acceptanceCount: Number(row.acceptanceCount),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Creates the next policy version.
 *
 * Always a new row rather than an update, so an acceptance always points at
 * the words that were actually agreed to.
 */
export async function createPolicyVersion(params: {
  title: string;
  body: string;
  publish: boolean;
  createdByUserId: string;
}): Promise<{ id: string; version: number }> {
  const organizationId = await getDefaultOrganizationId();

  const [latest] = await db
    .select({ version: schema.usagePolicy.version })
    .from(schema.usagePolicy)
    .where(eq(schema.usagePolicy.organizationId, organizationId))
    .orderBy(desc(schema.usagePolicy.version))
    .limit(1);

  const version = (latest?.version ?? 0) + 1;

  const [created] = await db
    .insert(schema.usagePolicy)
    .values({
      organizationId,
      version,
      title: params.title,
      body: params.body,
      publishedAt: params.publish ? new Date() : null,
      createdByUserId: params.createdByUserId,
    })
    .returning({ id: schema.usagePolicy.id });

  if (!created) throw new Error('Failed to create the policy version');
  return { id: created.id, version };
}

/** Publishes a draft, which re-prompts everyone who accepted an older one. */
export async function publishPolicy(policyId: string): Promise<boolean> {
  const organizationId = await getDefaultOrganizationId();

  const published = await db
    .update(schema.usagePolicy)
    .set({ publishedAt: new Date() })
    .where(
      and(
        eq(schema.usagePolicy.id, policyId),
        eq(schema.usagePolicy.organizationId, organizationId),
      ),
    )
    .returning({ id: schema.usagePolicy.id });

  return published.length > 0;
}

/** Marks the introduction complete and stores what the person told us. */
export async function completeIntroduction(params: {
  userId: string;
  displayName?: string | null;
  occupation?: string | null;
  traits?: string[];
  additionalContext?: string | null;
}): Promise<void> {
  await db
    .insert(schema.userPreference)
    .values({
      userId: params.userId,
      displayName: params.displayName ?? null,
      occupation: params.occupation ?? null,
      traits: params.traits ?? [],
      additionalContext: params.additionalContext ?? null,
      onboardedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.userPreference.userId,
      set: {
        displayName: params.displayName ?? null,
        occupation: params.occupation ?? null,
        traits: params.traits ?? [],
        additionalContext: params.additionalContext ?? null,
        onboardedAt: new Date(),
      },
    });
}

/** Records that someone chose to skip the introduction. */
export async function skipIntroduction(userId: string): Promise<void> {
  await db
    .insert(schema.userPreference)
    .values({ userId, onboardedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.userPreference.userId,
      set: { onboardedAt: new Date() },
    });
}

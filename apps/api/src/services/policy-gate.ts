import { and, desc, eq, isNotNull, schema } from '@oci/db';
import { db } from '../db/index.js';
import { onCacheInvalidation, publishInvalidation } from './cache-bus/index.js';
import { getDefaultOrganizationId } from './organization.js';

/**
 * Whether a person still owes the acceptable use policy (#367).
 *
 * The browser's gate (`onboardingStateFor`) was the only enforcement: a
 * person who had not accepted could still chat through the API. The API's
 * guard (middleware/policy-acceptance.ts) asks this for every write.
 *
 * Same rule as the browser's: the policy in force is the highest published
 * version, and a person has accepted it only by an acceptance of that exact
 * version. No published policy means nothing is owed.
 *
 * **Caching.** Writes are the hot path (every chat turn), and the policy
 * changes a few times a year, so the policy in force is kept for a short
 * time. A publish clears it here at once and on every other replica over the
 * cache bus; the expiry is the fallback when Redis is away. Only a *yes* is
 * remembered per person (an acceptance is never taken back), so a person who
 * has just accepted is let through on their next request, never after a wait.
 */

export interface PendingPolicy {
  id: string;
  version: number;
  title: string;
}

const POLICY_TTL_MS = 15_000;
const MAX_REMEMBERED = 20_000;

let policyCache: { policy: PendingPolicy | null; expiresAt: number } | null = null;
/** Bumped by every invalidation: a read that overlapped one is not kept. */
let generation = 0;
/** user id -> id of the policy version they accepted. */
const accepted = new Map<string, string>();

async function policyInForce(): Promise<PendingPolicy | null> {
  if (policyCache && Date.now() < policyCache.expiresAt) return policyCache.policy;
  const readGeneration = generation;
  const organizationId = await getDefaultOrganizationId();
  const [row] = await db
    .select({
      id: schema.usagePolicy.id,
      version: schema.usagePolicy.version,
      title: schema.usagePolicy.title,
    })
    .from(schema.usagePolicy)
    .where(
      and(
        eq(schema.usagePolicy.organizationId, organizationId),
        isNotNull(schema.usagePolicy.publishedAt),
      ),
    )
    .orderBy(desc(schema.usagePolicy.version))
    .limit(1);
  const policy = row ?? null;
  if (readGeneration === generation)
    policyCache = { policy, expiresAt: Date.now() + POLICY_TTL_MS };
  return policy;
}

/** The policy this person must still accept, or null when they owe nothing. */
export async function pendingPolicyFor(userId: string): Promise<PendingPolicy | null> {
  const policy = await policyInForce();
  if (!policy) return null;
  if (accepted.get(userId) === policy.id) return null;

  const [row] = await db
    .select({ id: schema.usagePolicyAcceptance.id })
    .from(schema.usagePolicyAcceptance)
    .where(
      and(
        eq(schema.usagePolicyAcceptance.policyId, policy.id),
        eq(schema.usagePolicyAcceptance.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return policy;

  if (accepted.size >= MAX_REMEMBERED) accepted.clear();
  accepted.set(userId, policy.id);
  return null;
}

function clearPolicyCache(): void {
  generation++;
  policyCache = null;
  accepted.clear();
}

/** A version was published (or the policy changed): forget it here and on every replica. */
export function invalidatePolicyCache(): void {
  clearPolicyCache();
  void publishInvalidation('usagePolicy');
}

onCacheInvalidation('usagePolicy', clearPolicyCache);

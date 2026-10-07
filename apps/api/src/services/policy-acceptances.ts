import { and, desc, eq, isNull, schema, sql } from '@oci/db';
import type { PolicyAcceptance, PolicyAcceptances } from '@oci/shared';
import { db } from '../db/index.js';
import { getDefaultOrganizationId } from './organization.js';

/**
 * Who accepted a published version, and when (#373; docs/admin/governance.md
 * promises "what exactly did this person agree to, and when"). The page showed
 * only a count, and no API answered it.
 *
 * Two sources, because an acceptance goes with its account when the account is
 * deleted: the acceptances of accounts that exist (with their email and name),
 * and the audit entries (`policy.accept`) of accounts that no longer do, whose
 * actor is null and whose email was recorded with the entry. Together they
 * keep the count honest: "N accepted, M since deleted".
 */
export const ACCEPTANCES_SHOWN = 200;

export async function listPolicyAcceptances(policyId: string): Promise<PolicyAcceptances | null> {
  const organizationId = await getDefaultOrganizationId();
  const [policy] = await db
    .select({ id: schema.usagePolicy.id })
    .from(schema.usagePolicy)
    .where(
      and(
        eq(schema.usagePolicy.id, policyId),
        eq(schema.usagePolicy.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!policy) return null;

  const log = schema.auditLog;
  const deletedAccounts = and(
    eq(log.action, 'policy.accept'),
    eq(log.targetId, policyId),
    isNull(log.actorUserId),
  );

  const [current, deleted, [accepted], [gone]] = await Promise.all([
    db
      .select({
        email: schema.user.email,
        name: schema.user.name,
        acceptedAt: schema.usagePolicyAcceptance.acceptedAt,
        ipAddress: schema.usagePolicyAcceptance.ipAddress,
      })
      .from(schema.usagePolicyAcceptance)
      .innerJoin(schema.user, eq(schema.user.id, schema.usagePolicyAcceptance.userId))
      .where(eq(schema.usagePolicyAcceptance.policyId, policyId))
      .orderBy(desc(schema.usagePolicyAcceptance.acceptedAt))
      .limit(ACCEPTANCES_SHOWN),
    db
      .select({ email: log.actorEmail, acceptedAt: log.createdAt, ipAddress: log.ipAddress })
      .from(log)
      .where(deletedAccounts)
      .orderBy(desc(log.createdAt))
      .limit(ACCEPTANCES_SHOWN),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(schema.usagePolicyAcceptance)
      .where(eq(schema.usagePolicyAcceptance.policyId, policyId)),
    db.select({ value: sql<number>`count(*)::int` }).from(log).where(deletedAccounts),
  ]);

  const rows: PolicyAcceptance[] = [
    ...current.map((row) => ({
      email: row.email,
      name: row.name,
      acceptedAt: row.acceptedAt.toISOString(),
      ipAddress: row.ipAddress,
      accountDeleted: false,
    })),
    ...deleted.map((row) => ({
      email: row.email,
      name: null,
      acceptedAt: row.acceptedAt.toISOString(),
      ipAddress: row.ipAddress,
      accountDeleted: true,
    })),
  ]
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
    .slice(0, ACCEPTANCES_SHOWN);

  return {
    acceptances: rows,
    accepted: Number(accepted?.value ?? 0),
    deleted: Number(gone?.value ?? 0),
    shown: rows.length,
  };
}

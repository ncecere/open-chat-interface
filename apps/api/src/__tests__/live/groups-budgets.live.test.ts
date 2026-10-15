import { randomUUID } from 'node:crypto';
import { eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { getUsageSummary, reserveQuotaForRun } = await import('../../services/quota/index.js');
const { invalidateSettingsCache } = await import('../../services/settings.js');
const { setUserOverride } = await import('../../services/quota/override-admin.js');

/**
 * The combination rule for budgets (v0.14, #394), as a table.
 *
 * A person's budgets are the distinct enabled policies attached to their role OR
 * to any of their groups. Each is checked on its own against the person's own
 * usage: every one is enforced, the most restrictive wins, nothing is summed and
 * a group budget can never raise a limit a role budget sets.
 */
interface Policy {
  /** The key the case refers to it by. */
  key: string;
  limit: number;
  roles?: UserRole[];
  /** Groups (by case-local name) the policy is attached to. */
  groups?: string[];
  enabled?: boolean;
  /** Models it covers; empty or absent covers every model. */
  models?: string[];
  /** A per-person override of its limit, for the case's person. */
  override?: number;
}

interface Case {
  name: string;
  role?: UserRole;
  policies: Policy[];
  /** Groups the person is in. */
  memberOf: string[];
  /** Other groups that exist, with nobody of interest in them. */
  otherGroups?: string[];
  /** Messages the person has already used (on 'm1'). */
  used: number;
  model?: string;
  /** The policies (by key) the person's allowances list, with the limit and what they used. */
  allowances: Record<string, { limit: number; used: number }>;
  allowed: boolean;
}

const cases: Case[] = [
  {
    name: 'a role budget alone, with room',
    policies: [{ key: 'R', limit: 10, roles: ['user'] }],
    memberOf: [],
    used: 5,
    allowances: { R: { limit: 10, used: 5 } },
    allowed: true,
  },
  {
    name: 'a role budget alone, spent',
    policies: [{ key: 'R', limit: 10, roles: ['user'] }],
    memberOf: [],
    used: 10,
    allowances: { R: { limit: 10, used: 10 } },
    allowed: false,
  },
  {
    name: 'a group budget alone, with room',
    policies: [{ key: 'G', limit: 3, groups: ['Physics'] }],
    memberOf: ['Physics'],
    used: 2,
    allowances: { G: { limit: 3, used: 2 } },
    allowed: true,
  },
  {
    name: 'a group budget alone, spent, with no role budget at all',
    policies: [{ key: 'G', limit: 3, groups: ['Physics'] }],
    memberOf: ['Physics'],
    used: 3,
    allowances: { G: { limit: 3, used: 3 } },
    allowed: false,
  },
  {
    name: 'a group budget stricter than the role budget wins',
    policies: [
      { key: 'R', limit: 10, roles: ['user'] },
      { key: 'G', limit: 3, groups: ['Physics'] },
    ],
    memberOf: ['Physics'],
    used: 3,
    allowances: { R: { limit: 10, used: 3 }, G: { limit: 3, used: 3 } },
    allowed: false,
  },
  {
    name: 'a group budget looser than the role budget never raises it',
    policies: [
      { key: 'R', limit: 3, roles: ['user'] },
      { key: 'G', limit: 100, groups: ['Physics'] },
    ],
    memberOf: ['Physics'],
    used: 3,
    allowances: { R: { limit: 3, used: 3 }, G: { limit: 100, used: 3 } },
    allowed: false,
  },
  {
    name: 'both budgets with room: allowed, and the usage is the person’s own (not summed)',
    policies: [
      { key: 'R', limit: 10, roles: ['user'] },
      { key: 'G', limit: 6, groups: ['Physics'] },
    ],
    memberOf: ['Physics'],
    used: 5,
    allowances: { R: { limit: 10, used: 5 }, G: { limit: 6, used: 5 } },
    allowed: true,
  },
  {
    name: 'one policy attached to the role and to the group counts once',
    policies: [{ key: 'B', limit: 4, roles: ['user'], groups: ['Physics'] }],
    memberOf: ['Physics'],
    used: 3,
    allowances: { B: { limit: 4, used: 3 } },
    allowed: true,
  },
  {
    name: 'one policy attached to two of the groups counts once',
    policies: [{ key: 'G', limit: 4, groups: ['Physics', 'Chemistry'] }],
    memberOf: ['Physics', 'Chemistry'],
    used: 4,
    allowances: { G: { limit: 4, used: 4 } },
    allowed: false,
  },
  {
    name: 'two groups, two policies: the stricter one is the limit, the other is not added to it',
    policies: [
      { key: 'G1', limit: 5, groups: ['Physics'] },
      { key: 'G2', limit: 8, groups: ['Chemistry'] },
    ],
    memberOf: ['Physics', 'Chemistry'],
    used: 5,
    allowances: { G1: { limit: 5, used: 5 }, G2: { limit: 8, used: 5 } },
    allowed: false,
  },
  {
    name: 'two groups, two policies, under both',
    policies: [
      { key: 'G1', limit: 5, groups: ['Physics'] },
      { key: 'G2', limit: 8, groups: ['Chemistry'] },
    ],
    memberOf: ['Physics', 'Chemistry'],
    used: 4,
    allowances: { G1: { limit: 5, used: 4 }, G2: { limit: 8, used: 4 } },
    allowed: true,
  },
  {
    name: 'an override on a group budget raises it for that person',
    policies: [{ key: 'G', limit: 3, groups: ['Physics'], override: 20 }],
    memberOf: ['Physics'],
    used: 5,
    allowances: { G: { limit: 20, used: 5 } },
    allowed: true,
  },
  {
    name: 'an override on a policy both the role and a group carry applies once',
    policies: [{ key: 'B', limit: 3, roles: ['user'], groups: ['Physics'], override: 9 }],
    memberOf: ['Physics'],
    used: 5,
    allowances: { B: { limit: 9, used: 5 } },
    allowed: true,
  },
  {
    name: 'an override on the group budget does not loosen the role budget',
    policies: [
      { key: 'R', limit: 4, roles: ['user'] },
      { key: 'G', limit: 3, groups: ['Physics'], override: 50 },
    ],
    memberOf: ['Physics'],
    used: 4,
    allowances: { R: { limit: 4, used: 4 }, G: { limit: 50, used: 4 } },
    allowed: false,
  },
  {
    name: 'a disabled group budget is ignored',
    policies: [{ key: 'G', limit: 1, groups: ['Physics'], enabled: false }],
    memberOf: ['Physics'],
    used: 50,
    allowances: {},
    allowed: true,
  },
  {
    name: 'a group budget scoped to another model does not apply to this one',
    policies: [{ key: 'G', limit: 1, groups: ['Physics'], models: ['other'] }],
    memberOf: ['Physics'],
    used: 0,
    allowances: { G: { limit: 1, used: 0 } },
    allowed: true,
  },
  {
    name: 'a group budget scoped to this model applies to it',
    policies: [{ key: 'G', limit: 2, groups: ['Physics'], models: ['m1'] }],
    memberOf: ['Physics'],
    used: 2,
    allowances: { G: { limit: 2, used: 2 } },
    allowed: false,
  },
  {
    name: 'a group the person is not in does nothing to them',
    policies: [{ key: 'G', limit: 1, groups: ['Physics'] }],
    memberOf: [],
    otherGroups: ['Physics'],
    used: 50,
    allowances: {},
    allowed: true,
  },
  {
    name: 'a person in another group is held to that group’s budget only',
    policies: [
      { key: 'G1', limit: 1, groups: ['Physics'] },
      { key: 'G2', limit: 100, groups: ['Chemistry'] },
    ],
    memberOf: ['Chemistry'],
    otherGroups: ['Physics'],
    used: 50,
    allowances: { G2: { limit: 100, used: 50 } },
    allowed: true,
  },
  {
    name: 'a restricted person with a group budget and no role budget',
    role: 'restricted',
    policies: [
      { key: 'R', limit: 1, roles: ['user'] },
      { key: 'G', limit: 3, groups: ['Physics'] },
    ],
    memberOf: ['Physics'],
    used: 3,
    allowances: { G: { limit: 3, used: 3 } },
    allowed: false,
  },
];

describe.skipIf(!available)('live: the budget combination rule (groups)', () => {
  let live: LiveDatabase;
  let organizationId: string;
  const policyIds: string[] = [];
  const groupIds: string[] = [];

  beforeAll(async () => {
    live = await createLiveDatabase('groups_budgets');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId, kind: 'openai', label: 'No calls' })
      .returning();
    for (const slug of ['m1', 'other']) {
      await live.db.insert(schema.model).values({
        organizationId,
        providerId: provider!.id,
        slug,
        upstreamModelId: slug,
        displayName: slug,
      });
    }
  });

  afterEach(async () => {
    for (const id of policyIds.splice(0)) {
      await live.db.delete(schema.quotaPolicy).where(eq(schema.quotaPolicy.id, id));
    }
    for (const id of groupIds.splice(0)) {
      await live.db.delete(schema.group).where(eq(schema.group.id, id));
    }
  });

  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  async function arrange(testCase: Case) {
    const role = testCase.role ?? 'user';
    const person = await seedUser(live.db, organizationId, { role });
    const admin = await seedUser(live.db, organizationId, { role: 'admin' });
    const groups = new Map<string, string>();
    for (const name of new Set([
      ...testCase.memberOf,
      ...(testCase.otherGroups ?? []),
      ...testCase.policies.flatMap((p) => p.groups ?? []),
    ])) {
      const [group] = await live.db
        .insert(schema.group)
        .values({ organizationId, name: `${name} ${randomUUID().slice(0, 6)}` })
        .returning();
      groups.set(name, group!.id);
      groupIds.push(group!.id);
    }
    for (const name of testCase.memberOf) {
      await live.db
        .insert(schema.groupMember)
        .values({ groupId: groups.get(name)!, userId: person });
    }
    const byKey = new Map<string, string>();
    for (const policy of testCase.policies) {
      const [row] = await live.db
        .insert(schema.quotaPolicy)
        .values({
          organizationId,
          name: `${policy.key} ${randomUUID().slice(0, 6)}`,
          metric: 'messages',
          limitValue: policy.limit,
          windowKind: 'rolling',
          windowHours: 24,
          enabled: policy.enabled ?? true,
        })
        .returning();
      policyIds.push(row!.id);
      byKey.set(policy.key, row!.id);
      for (const role of policy.roles ?? []) {
        await live.db.insert(schema.quotaPolicyRole).values({ policyId: row!.id, role });
      }
      for (const group of policy.groups ?? []) {
        await live.db
          .insert(schema.quotaPolicyGroup)
          .values({ policyId: row!.id, groupId: groups.get(group)! });
      }
      for (const slug of policy.models ?? []) {
        await live.db
          .insert(schema.quotaPolicyModel)
          .values({ policyId: row!.id, modelSlug: slug });
      }
      if (policy.override !== undefined) {
        await setUserOverride({ id: admin, email: 'admin@example.test' }, person, {
          policyId: row!.id,
          limitValue: policy.override,
          reason: 'case',
        } as never);
      }
    }
    if (testCase.used > 0) {
      await live.db.insert(schema.usageEvent).values({
        organizationId,
        userId: person,
        modelSlug: 'm1',
        messageCount: testCase.used,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: 0,
        pending: false,
      });
    }
    return { person, role, byKey };
  }

  it.each(cases)('$name', async (testCase) => {
    const { person, role, byKey } = await arrange(testCase);

    const summary = await getUsageSummary(person, role);
    const byId = new Map([...byKey].map(([key, id]) => [id, key]));
    const seen = Object.fromEntries(
      summary.allowances.map((a) => [
        byId.get(a.policyId) ?? `unknown:${a.policyId}`,
        { limit: a.limitValue, used: a.used },
      ]),
    );
    expect(seen).toEqual(testCase.allowances);
    // Never listed twice.
    expect(new Set(summary.allowances.map((a) => a.policyId)).size).toBe(summary.allowances.length);

    const attempt = reserveQuotaForRun({
      userId: person,
      role,
      modelSlug: testCase.model ?? 'm1',
    });
    if (testCase.allowed) await expect(attempt).resolves.toBeDefined();
    else await expect(attempt).rejects.toMatchObject({ status: 429 });
  });

  it('stops a group budget at once when the person leaves the group, and starts it when they join', async () => {
    const person = await seedUser(live.db, organizationId, { role: 'user' });
    const [group] = await live.db
      .insert(schema.group)
      .values({ organizationId, name: 'Joiners' })
      .returning();
    groupIds.push(group!.id);
    const [policy] = await live.db
      .insert(schema.quotaPolicy)
      .values({
        organizationId,
        name: 'Joiners budget',
        metric: 'messages',
        limitValue: 1,
        windowKind: 'rolling',
        windowHours: 24,
      })
      .returning();
    policyIds.push(policy!.id);
    await live.db
      .insert(schema.quotaPolicyGroup)
      .values({ policyId: policy!.id, groupId: group!.id });
    await live.db.insert(schema.usageEvent).values({
      organizationId,
      userId: person,
      modelSlug: 'm1',
      messageCount: 5,
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
      pending: false,
    });

    expect((await getUsageSummary(person, 'user')).allowances).toHaveLength(0);
    await live.db.insert(schema.groupMember).values({ groupId: group!.id, userId: person });
    expect((await getUsageSummary(person, 'user')).allowances).toHaveLength(1);
    await expect(
      reserveQuotaForRun({ userId: person, role: 'user', modelSlug: 'm1' }),
    ).rejects.toMatchObject({ status: 429 });
    await live.db.delete(schema.groupMember).where(eq(schema.groupMember.userId, person));
    expect((await getUsageSummary(person, 'user')).allowances).toHaveLength(0);
    await expect(
      reserveQuotaForRun({ userId: person, role: 'user', modelSlug: 'm1' }),
    ).resolves.toBeDefined();
  });
});

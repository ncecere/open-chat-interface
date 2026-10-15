import type {
  AdminGroup,
  AdminGroupDetail,
  AdminGroupsPage,
  GroupMember,
  GroupMembersPage,
  GroupUsage,
  ManagedGroup,
} from '@oci/shared';

/** Responses of the groups API as the web pages read them (docs/dev/groups-api.md). */

export function group(overrides: Partial<AdminGroup> = {}): AdminGroup {
  return {
    id: 'group-1',
    name: 'Biology',
    description: 'The biology department',
    memberCount: 3,
    managerCount: 1,
    policyCount: 1,
    modelCount: 2,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  };
}

export function groupsPage(
  groups: AdminGroup[] = [group()],
  overrides: Partial<AdminGroupsPage> = {},
): AdminGroupsPage {
  return { groups, page: 1, pageSize: 50, total: groups.length, limit: 500, ...overrides };
}

export function groupDetail(overrides: Partial<AdminGroupDetail> = {}): AdminGroupDetail {
  return {
    ...group(),
    grants: {
      policies: [{ id: 'policy-1', name: 'Biology monthly', enabled: true }],
      models: [
        { id: 'model-1', slug: 'alpha', displayName: 'Alpha', enabled: true },
        { id: 'model-2', slug: 'gamma', displayName: 'Gamma', enabled: false },
      ],
    },
    createdByName: 'Dana Admin',
    sharedProjectCount: 0,
    ...overrides,
  };
}

export function member(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    userId: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    role: 'member',
    addedAt: '2026-10-03T09:00:00.000Z',
    ...overrides,
  };
}

export function membersPage(
  members: GroupMember[] = [
    member(),
    member({
      userId: 'user-2',
      name: 'Grace Hopper',
      email: 'grace@example.test',
      role: 'manager',
    }),
  ],
  overrides: Partial<GroupMembersPage> = {},
): GroupMembersPage {
  return { members, page: 1, pageSize: 50, total: members.length, ...overrides };
}

export function usage(overrides: Partial<GroupUsage> = {}): GroupUsage {
  return {
    days: 30,
    since: '2026-09-14T00:00:00.000Z',
    memberCount: 3,
    totals: { messages: 120, tokensIn: 4000, tokensOut: 9000, costMicros: 2_500_000 },
    people: [
      {
        userId: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        messages: 100,
        tokensIn: 3000,
        tokensOut: 8000,
        costMicros: 2_000_000,
      },
    ],
    truncated: false,
    ...overrides,
  };
}

export function managed(overrides: Partial<ManagedGroup> = {}): ManagedGroup {
  return {
    id: 'group-1',
    name: 'Biology',
    description: 'The biology department',
    memberCount: 3,
    managerCount: 1,
    memberLimit: 5000,
    ...overrides,
  };
}

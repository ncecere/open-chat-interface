import {
  addGroupMembersSchema,
  createGroupSchema,
  GROUP_NAME_MAX_LENGTH,
  groupUsageQuerySchema,
  listGroupsQuerySchema,
  MAX_EMAILS_PER_ADD,
  managerAddGroupMembersSchema,
  PROTECTED_AUDIT_ACTIONS,
  putGroupGrantsSchema,
  updateGroupMemberSchema,
  updateGroupSchema,
} from '@oci/shared';
import { describe, expect, it, vi } from 'vitest';

const replicas = vi.hoisted(() => ({
  next: null as null | { version: string }[] | 'fails',
}));
vi.mock('../../services/jobs/workers.js', () => ({
  liveReplicas: async () => {
    if (replicas.next === 'fails') throw new Error('Redis is down');
    return replicas.next;
  },
}));
const { assertNoOlderReplicas, isOlderMinor } = await import(
  '../../services/groups/upgrade-guard.js'
);

describe('group request schemas', () => {
  it('trims names, bounds them, and refuses unknown fields', () => {
    expect(createGroupSchema.parse({ name: '  Physics  ' })).toEqual({ name: 'Physics' });
    expect(createGroupSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(
      createGroupSchema.safeParse({ name: 'x'.repeat(GROUP_NAME_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(createGroupSchema.safeParse({ name: 'ok', description: 'x'.repeat(301) }).success).toBe(
      false,
    );
    expect(createGroupSchema.safeParse({ name: 'ok', managers: [] }).success).toBe(false);
    expect(updateGroupSchema.parse({ description: null })).toEqual({ description: null });
  });

  it('lower-cases and de-duplicates addresses, defaults the role, and caps the request', () => {
    expect(addGroupMembersSchema.parse({ emails: ['A@x.test', ' a@X.test ', 'b@x.test'] })).toEqual(
      {
        emails: ['a@x.test', 'b@x.test'],
        role: 'member',
      },
    );
    expect(addGroupMembersSchema.safeParse({ emails: [] }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ emails: ['not an email'] }).success).toBe(false);
    expect(addGroupMembersSchema.safeParse({ emails: ['a@x.test'], role: 'owner' }).success).toBe(
      false,
    );
    const many = Array.from({ length: MAX_EMAILS_PER_ADD + 1 }, (_, i) => `p${i}@x.test`);
    expect(addGroupMembersSchema.safeParse({ emails: many }).success).toBe(false);
    expect(
      managerAddGroupMembersSchema.safeParse({ emails: ['a@x.test'], role: 'manager' }).success,
    ).toBe(false);
    expect(updateGroupMemberSchema.parse({ role: 'manager' })).toEqual({ role: 'manager' });
  });

  it('requires both grant lists so an omitted one cannot clear it', () => {
    expect(putGroupGrantsSchema.safeParse({ policyIds: [] }).success).toBe(false);
    expect(putGroupGrantsSchema.safeParse({ modelIds: [] }).success).toBe(false);
    expect(putGroupGrantsSchema.parse({ policyIds: ['a', 'a'], modelIds: [] })).toEqual({
      policyIds: ['a'],
      modelIds: [],
    });
  });

  it('coerces paging and usage queries from strings', () => {
    expect(listGroupsQuerySchema.parse({ page: '2', pageSize: '10' })).toMatchObject({
      page: 2,
      pageSize: 10,
    });
    expect(listGroupsQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(groupUsageQuerySchema.parse({})).toEqual({ days: 30 });
    expect(groupUsageQuerySchema.safeParse({ days: '91' }).success).toBe(false);
  });

  it('protects every group.* audit action from retention', () => {
    for (const action of [
      'group.create',
      'group.update',
      'group.delete',
      'group.member.add',
      'group.member.remove',
      'group.member.role',
      'group.grants.update',
    ]) {
      expect(PROTECTED_AUDIT_ACTIONS).toContain(action);
    }
  });
});

describe('isOlderMinor (the mixed-version guard)', () => {
  it('compares major and minor, never the patch', () => {
    expect(isOlderMinor('0.13.4', '0.14.0')).toBe(true);
    expect(isOlderMinor('v0.13.9', '0.14.0')).toBe(true);
    expect(isOlderMinor('0.14.0', '0.14.2')).toBe(false);
    expect(isOlderMinor('0.14.2', '0.14.0')).toBe(false);
    expect(isOlderMinor('0.15.0', '0.14.0')).toBe(false);
    expect(isOlderMinor('garbage', '0.14.0')).toBe(false);
  });
});

describe('assertNoOlderReplicas', () => {
  it('passes without heartbeats, when they cannot be read, and when no replica is older', async () => {
    replicas.next = null;
    await expect(assertNoOlderReplicas()).resolves.toBeUndefined();
    replicas.next = 'fails';
    await expect(assertNoOlderReplicas()).resolves.toBeUndefined();
    replicas.next = [{ version: '0.13.1' }, { version: '0.99.0' }];
    await expect(assertNoOlderReplicas()).resolves.toBeUndefined();
  });

  it('refuses with 409 while an earlier minor release serves', async () => {
    replicas.next = [{ version: '0.12.9' }, { version: '0.13.1' }];
    await expect(assertNoOlderReplicas()).rejects.toMatchObject({
      status: 409,
      message: 'An upgrade is still in progress',
    });
  });
});

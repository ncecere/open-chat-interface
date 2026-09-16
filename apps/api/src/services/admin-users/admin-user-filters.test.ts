import { schema } from '@oci/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), update: vi.fn(), delete: vi.fn() },
  createUser: vi.fn(),
  sendVerificationEmail: vi.fn(),
  isEmailVerificationEnforced: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('../../db/index.js', () => ({ db: mocks.db }));
vi.mock('../../auth/index.js', () => ({
  auth: {
    api: { createUser: mocks.createUser, sendVerificationEmail: mocks.sendVerificationEmail },
  },
}));
vi.mock('../../auth/policy.js', () => ({
  isEmailVerificationEnforced: mocks.isEmailVerificationEnforced,
}));
vi.mock('../audit.js', () => ({ recordAudit: mocks.recordAudit }));

import { applyBulkUserAction, bulkActionSchema } from './bulk-actions.js';
import { getUserDetail } from './detail.js';
import { listQuerySchema, listUsers, toAdminUser } from './listing.js';
import { createUser, deleteUser, revokeUserSessions, updateUser } from './mutations.js';

function query(rows: unknown[] = []) {
  const result = Promise.resolve(rows);
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally thenable.
    then: result.then.bind(result),
  };
}

const actor = { id: 'admin', email: 'admin@example.com' };
const row = {
  id: 'target',
  email: 'target@example.com',
  name: 'Target',
  image: null,
  role: 'auditor',
  emailVerified: true,
  banned: false,
  banReason: null,
  lastSeenAt: null,
  createdAt: new Date('2025-01-02T03:04:05Z'),
  threadCount: 3,
  messageCount: 8,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.select.mockImplementation(() => query());
  mocks.db.update.mockImplementation(() => query([{ id: 'target' }]));
  mocks.db.delete.mockImplementation(() => query());
  mocks.createUser.mockResolvedValue({ user: { id: 'target' } });
  mocks.isEmailVerificationEnforced.mockResolvedValue(false);
});

describe('admin user listing and detail', () => {
  it('preserves query defaults, coercion, trimming and bounds', () => {
    expect(listQuerySchema.parse({})).toEqual({
      sort: 'created',
      direction: 'desc',
      limit: 50,
      offset: 0,
    });
    expect(listQuerySchema.parse({ search: ' Alice ', limit: '200', offset: '50' })).toMatchObject({
      search: 'Alice',
      limit: 200,
      offset: 50,
    });
    for (const input of [{ limit: 201 }, { offset: -1 }, { role: 'owner' }, { sort: 'unknown' }]) {
      expect(listQuerySchema.safeParse(input).success).toBe(false);
    }
  });

  it('serializes nullable dates and account counts without changing role', () => {
    expect(toAdminUser(row)).toEqual({ ...row, createdAt: row.createdAt.toISOString() });
    expect(toAdminUser({ ...row, lastSeenAt: row.createdAt }).lastSeenAt).toBe(
      row.createdAt.toISOString(),
    );
  });

  it('shares the filter between count and rows and applies stable ordering and paging', async () => {
    const rows = query([row]);
    const totals = query([{ value: 72 }]);
    mocks.db.select.mockReturnValueOnce(rows).mockReturnValueOnce(totals);
    const result = await listUsers(
      listQuerySchema.parse({
        search: 'Alice',
        role: 'auditor',
        status: 'active',
        sort: 'threads',
        limit: 20,
        offset: 40,
      }),
    );
    expect(result).toEqual({ users: [toAdminUser(row)], total: 72 });
    expect(rows.where.mock.calls[0]?.[0]).toBe(totals.where.mock.calls[0]?.[0]);
    expect(rows.orderBy.mock.calls[0]).toHaveLength(2);
    expect(rows.limit).toHaveBeenCalledWith(20);
    expect(rows.offset).toHaveBeenCalledWith(40);
  });

  it('loads all six detail collections and serializes their dates', async () => {
    const date = row.createdAt;
    for (const rows of [
      [row],
      [{ value: 4 }],
      [{ value: 9 }],
      [{ bytes: '120', files: 2 }],
      [{ id: 'session', createdAt: date, expiresAt: date }],
      [{ id: 'thread', updatedAt: date }],
      [{ id: 'audit', createdAt: date }],
    ])
      mocks.db.select.mockReturnValueOnce(query(rows));
    const detail = await getUserDetail('target');
    expect(mocks.db.select).toHaveBeenCalledTimes(7);
    expect(detail.user).toMatchObject({ threadCount: 4, messageCount: 9 });
    expect(detail.storage).toEqual({ bytesUsed: 120, fileCount: 2 });
    expect(detail.sessions[0]).toMatchObject({
      createdAt: date.toISOString(),
      expiresAt: date.toISOString(),
    });
    expect(detail.recentThreads[0]?.updatedAt).toBe(date.toISOString());
    expect(detail.audit[0]?.createdAt).toBe(date.toISOString());
  });

  it('rejects missing detail before loading related records', async () => {
    await expect(getUserDetail('missing')).rejects.toMatchObject({
      message: 'User not found',
      status: 404,
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });
});

describe('bulk user actions', () => {
  it('retains validation order and bounded input', async () => {
    expect(
      bulkActionSchema.safeParse({ userIds: Array(201).fill('target'), action: 'ban' }).success,
    ).toBe(false);
    await expect(
      applyBulkUserAction(actor, { userIds: [actor.id], action: 'set_role' }, null),
    ).rejects.toMatchObject({ message: 'Choose a role to apply.' });
    await expect(
      applyBulkUserAction(actor, { userIds: [actor.id], action: 'ban' }, null),
    ).rejects.toMatchObject({ message: 'Select an account other than your own.' });
    expect(mocks.db.update).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it('excludes self, bans before removing sessions and preserves the audit payload', async () => {
    const update = query([{ id: 'target' }]);
    mocks.db.update.mockReturnValueOnce(update);
    expect(
      await applyBulkUserAction(
        actor,
        {
          userIds: ['admin', 'target', 'target'],
          action: 'ban',
          reason: 'Reason',
          role: 'user',
        },
        '192.0.2.1',
      ),
    ).toEqual({ affected: 1, skippedSelf: true });
    expect(update.set).toHaveBeenCalledWith({ banned: true, banReason: 'Reason' });
    expect(mocks.db.delete).toHaveBeenCalledWith(schema.session);
    expect(mocks.db.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.db.delete.mock.invocationCallOrder[0]!,
    );
    expect(mocks.db.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordAudit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.recordAudit).toHaveBeenCalledWith({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.bulk.ban',
      targetType: 'user',
      targetId: null,
      ipAddress: '192.0.2.1',
      metadata: { requested: 3, affected: 1, role: 'user', userIds: ['target', 'target'] },
    });
  });

  it('unbans without deleting sessions and counts revoked sessions rather than users', async () => {
    const update = query([{ id: 'target' }]);
    mocks.db.update.mockReturnValueOnce(update);
    await applyBulkUserAction(
      actor,
      { userIds: ['target'], action: 'unban', reason: 'ignored' },
      null,
    );
    expect(update.set).toHaveBeenCalledWith({ banned: false, banReason: null });
    expect(mocks.db.delete).not.toHaveBeenCalled();
    mocks.db.delete.mockReturnValueOnce(query([{ id: 'one' }, { id: 'two' }]));
    expect(
      await applyBulkUserAction(actor, { userIds: ['target'], action: 'revoke_sessions' }, null),
    ).toEqual({ affected: 2, skippedSelf: false });
  });
});

describe('individual user mutations', () => {
  const input = {
    email: row.email,
    name: row.name,
    password: 'long-password',
    role: 'restricted' as const,
  };

  it('keeps the restricted-role override and verification delivery fallback', async () => {
    mocks.isEmailVerificationEnforced.mockResolvedValue(true);
    mocks.sendVerificationEmail.mockRejectedValue(new Error('Delivery failed'));
    const roleUpdate = query();
    const verificationUpdate = query();
    mocks.db.update.mockReturnValueOnce(roleUpdate).mockReturnValueOnce(verificationUpdate);
    expect(await createUser(actor, input)).toEqual({ id: 'target' });
    expect(mocks.createUser).toHaveBeenCalledWith({ body: { ...input, role: 'user' } });
    expect(roleUpdate.set).toHaveBeenCalledWith({ role: 'restricted' });
    expect(verificationUpdate.set).toHaveBeenCalledWith({ emailVerified: true });
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith({
      body: { email: input.email, callbackURL: '/' },
    });
    expect(mocks.recordAudit).toHaveBeenCalledWith({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.create',
      targetType: 'user',
      targetId: 'target',
      metadata: { email: input.email, role: 'restricted' },
    });
  });

  it('persists the requested auditor role before reporting creation success', async () => {
    const update = query();
    mocks.db.update.mockReturnValueOnce(update);
    await createUser(actor, { ...input, role: 'auditor' });
    expect(mocks.createUser).toHaveBeenCalledWith({ body: { ...input, role: 'user' } });
    expect(update.set).toHaveBeenCalledWith({ role: 'auditor' });
    expect(mocks.db.update).toHaveBeenCalledTimes(2);
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled();
    expect(mocks.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { email: input.email, role: 'auditor' },
      }),
    );
  });

  it('rejects duplicate creation before contacting Better Auth', async () => {
    mocks.db.select.mockReturnValueOnce(query([{ id: 'existing' }]));
    await expect(createUser(actor, input)).rejects.toMatchObject({
      message: 'A user with that email already exists',
      status: 409,
    });
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('checks existence before self guards and preserves exact patch audit metadata', async () => {
    await expect(updateUser(actor, actor.id, { role: 'user' })).rejects.toMatchObject({
      message: 'User not found',
    });
    mocks.db.select.mockImplementation(() => query([row]));
    await expect(updateUser(actor, actor.id, { role: 'user' })).rejects.toMatchObject({
      message: 'You cannot remove your own administrator role',
    });
    await expect(updateUser(actor, actor.id, { banned: true })).rejects.toMatchObject({
      message: 'You cannot ban your own account',
    });
    const patch = { name: 'Changed', banned: true, banReason: 'Reason' };
    expect(await updateUser(actor, 'target', patch)).toEqual({ id: 'target' });
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(mocks.recordAudit).toHaveBeenCalledWith({
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: 'user.update',
      targetType: 'user',
      targetId: 'target',
      metadata: patch,
    });
  });

  it('retains self-delete protection and idempotent delete/revoke responses', async () => {
    await expect(deleteUser(actor, actor.id)).rejects.toMatchObject({
      message: 'You cannot delete your own account',
    });
    expect(mocks.db.delete).not.toHaveBeenCalled();
    expect(await deleteUser(actor, 'missing')).toEqual({ ok: true });
    expect(await revokeUserSessions(actor, 'missing')).toEqual({ ok: true });
    expect(mocks.recordAudit.mock.calls.map(([entry]) => entry.action)).toEqual([
      'user.delete',
      'user.revoke_sessions',
    ]);
  });
});

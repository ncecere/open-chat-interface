import { schema, sql } from '@oci/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type ComplianceContext, useComplianceSuite } from '../../../test/compliance.fixtures.js';
import { liveS3Available } from '../../../test/live-backup-tools.js';
import { livePostgresAvailable, seedUser } from '../../../test/live-postgres.js';

/**
 * Legal hold end to end: real PostgreSQL, the real admin routes and the real
 * retention jobs, which skip held people and unexported audit entries.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
  env: {} as Record<string, unknown>,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
// The job lock opens its own connection from DATABASE_URL.
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...state.env }) };
});
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    const next = { ...((state.settings.get(key) ?? {}) as object), ...patch };
    state.settings.set(key, next);
    return next;
  },
}));

const available = (await livePostgresAvailable()) && (await liveS3Available());

describe.skipIf(!available)('live: compliance export and legal hold', () => {
  const suite = useComplianceSuite(state);
  const { separateTarget, audit, thread, exists, call } = suite;
  let pool: ComplianceContext['pool'];
  let admin: ComplianceContext['admin'];
  let auditor: ComplianceContext['auditor'];
  let exporter: ComplianceContext['exporter'];
  beforeAll(() => {
    ({ pool, admin, auditor, exporter } = suite.ctx);
  });

  it('skips held people in retention, trash purging, temporary expiry and account deletion', async () => {
    const held = await seedUser(pool.db, state.organizationId, { email: 'held@example.test' });
    const free = await seedUser(pool.db, state.organizationId, { email: 'free@example.test' });
    state.settings.set('retention', {
      threadRetentionDays: 30,
      trashRetentionDays: 7,
      auditLogRetentionDays: 30,
      exemptPinnedThreads: false,
    });
    const old = new Date(Date.now() - 90 * 86_400_000);
    const fixtures = new Map<string, { held: string; free: string }>();
    for (const [name, fields] of [
      ['inactive', { lastMessageAt: old }],
      ['trashed', { deletedAt: old }],
      ['temporary', { temporary: true, expiresAt: old }],
    ] as const)
      fixtures.set(name, { held: await thread(held, fields), free: await thread(free, fields) });
    await audit('old.by.held', old, held);
    await audit('old.by.free', old, free);

    let response = await call('POST', '/api/admin/compliance/holds', {
      body: { email: 'HELD@example.test', reason: 'Matter 2026-17' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { hold } = (await response.json()) as { hold: { id: string } };
    response = await call('POST', '/api/admin/compliance/holds', {
      body: { userId: held, reason: 'Again' },
    });
    expect(response.status).toBe(409);

    const { applyThreadRetention, pruneAuditLog } = await import(
      '../../services/lifecycle/retention.js'
    );
    const { purgeExpiredTrash, emptyTrash } = await import('../../services/lifecycle/trash.js');
    const { purgeExpiredTemporaryThreads } = await import('../../services/threads.js');
    expect(await applyThreadRetention()).toBe(1);
    expect(await purgeExpiredTrash()).toBe(1);
    expect(await purgeExpiredTemporaryThreads()).toBe(1);
    await pruneAuditLog();

    const deletedAt = async (id: string) => {
      const [row] = await pool.db.execute<{ deleted_at: string | null }>(
        sql`select deleted_at from thread where id = ${id}`,
      );
      return row?.deleted_at ?? null;
    };
    expect(await deletedAt(fixtures.get('inactive')!.held)).toBeNull();
    expect(await deletedAt(fixtures.get('inactive')!.free)).not.toBeNull();
    expect(await exists('thread', fixtures.get('trashed')!.held)).toBe(true);
    expect(await exists('thread', fixtures.get('trashed')!.free)).toBe(false);
    expect(await exists('thread', fixtures.get('temporary')!.held)).toBe(true);
    expect(await exists('thread', fixtures.get('temporary')!.free)).toBe(false);
    const actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).toContain('old.by.held');
    expect(actions).not.toContain('old.by.free');

    // Their own permanent deletion is paused too; moving to the trash is not.
    await expect(emptyTrash(held)).rejects.toMatchObject({ status: 409 });
    // (The free person's inactive conversation, which retention just trashed.)
    expect(await emptyTrash(free)).toBe(1);

    // Marked in the users list and on the account page.
    response = await call('GET', '/api/admin/users?search=example.test&limit=200', {
      user: auditor,
    });
    const listing = (await response.json()) as {
      users: Array<{ id: string; legalHold: boolean }>;
    };
    expect(listing.users.find((user) => user.id === held)?.legalHold).toBe(true);
    expect(listing.users.find((user) => user.id === free)?.legalHold).toBe(false);
    response = await call('GET', `/api/admin/users/${held}`, { user: auditor });
    expect(await response.json()).toMatchObject({
      user: { legalHold: true },
      legalHold: { reason: 'Matter 2026-17', placedByEmail: 'admin@example.test' },
    });

    // Account deletion is refused with a clear reason, by the route and by the database.
    response = await call('DELETE', `/api/admin/users/${held}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /legal hold/,
    );
    await expect(pool.db.execute(sql`delete from "user" where id = ${held}`)).rejects.toThrow();
    expect(await exists('user', held)).toBe(true);
    response = await call('DELETE', `/api/admin/users/${free}`);
    expect(response.status).toBe(200);
    expect(await exists('user', free)).toBe(false);

    // Lifted: everything applies again.
    response = await call('POST', `/api/admin/compliance/holds/${hold.id}/lift`, {
      body: { reason: 'Matter closed' },
    });
    expect(response.status).toBe(200);
    expect(await purgeExpiredTrash()).toBe(1);
    response = await call('DELETE', `/api/admin/users/${held}`);
    expect(response.status).toBe(200);
    expect(await exists('user', held)).toBe(false);

    const entries = await pool.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.action} like 'compliance.hold.%'`)
      .orderBy(schema.auditLog.seq);
    expect(entries.map((entry) => entry.action)).toEqual([
      'compliance.hold.place',
      'compliance.hold.lift',
    ]);
    expect(entries[0]).toMatchObject({ actorUserId: admin, targetType: 'user', targetId: held });
    expect(entries[0]!.metadata).toMatchObject({ reason: 'Matter 2026-17' });
    expect(entries[1]!.metadata).toMatchObject({ reason: 'Matter closed' });
  });

  it('keeps unexported audit entries from retention while the export is on', async () => {
    state.settings.set('retention', { auditLogRetentionDays: 30 });
    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    const old = new Date(Date.now() - 90 * 86_400_000);
    await exporter.performComplianceExport({ trigger: 'schedule' });
    await audit('old.unexported', old, null);
    const { pruneAuditLog } = await import('../../services/lifecycle/retention.js');
    await pruneAuditLog();
    let actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).toContain('old.unexported');
    await exporter.performComplianceExport({ trigger: 'schedule' });
    await pruneAuditLog();
    actions = (await pool.db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).not.toContain('old.unexported');
  });
});

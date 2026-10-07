import { randomUUID } from 'node:crypto';
import { eq, schema, sql } from '@oci/db';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type ComplianceContext, useComplianceSuite } from '../../../test/compliance.fixtures.js';
import { liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import { livePostgresAvailable, seedUser } from '../../../test/live-postgres.js';

/**
 * Compliance export administration end to end: real PostgreSQL, MinIO as the
 * destination and the real admin routes: the admin page and System health.
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
  const { separateTarget, audit, call } = suite;
  let pool: ComplianceContext['pool'];
  let admin: ComplianceContext['admin'];
  let auditor: ComplianceContext['auditor'];
  let exporter: ComplianceContext['exporter'];
  beforeAll(() => {
    ({ pool, admin, auditor, exporter } = suite.ctx);
  });

  it('serves the page to auditors read-only and changes, tests and runs for admins', async () => {
    const target = await separateTarget();
    let response = await call('GET', '/api/admin/compliance', { user: auditor });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      settings: { enabled: false, includeContent: false, keepDays: null, schedule: 'daily' },
      cursor: { audit: 0, messages: null },
    });
    for (const [method, path, body] of [
      ['PATCH', '/api/admin/compliance/settings', { enabled: true }],
      ['POST', '/api/admin/compliance/run', undefined],
      ['POST', '/api/admin/compliance/test', undefined],
      ['POST', '/api/admin/compliance/holds', { userId: admin, reason: 'x' }],
      ['POST', '/api/admin/compliance/holds/any/lift', {}],
    ] as const) {
      response = await call(method, path, { user: auditor, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // Turning on is refused while the destination is incomplete.
    response = await call('PATCH', '/api/admin/compliance/settings', {
      body: { enabled: true, destination: 'separate', s3: { bucket: target.bucket } },
    });
    expect(response.status).toBe(422);

    response = await call('PATCH', '/api/admin/compliance/settings', {
      body: {
        enabled: true,
        schedule: 'hourly',
        destination: 'separate',
        prefix: 'via-api/',
        keepDays: 365,
        s3: {
          bucket: target.bucket,
          region: 'us-east-1',
          endpoint: liveS3Config.endpoint,
          accessKeyId: liveS3Config.accessKeyId,
          secretAccessKey: liveS3Config.secretAccessKey,
          forcePathStyle: true,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as Record<string, unknown>;
    expect(saved).toMatchObject({
      settings: { enabled: true, schedule: 'hourly', keepDays: 365, s3: { hasCredential: true } },
    });
    expect(JSON.stringify(saved)).not.toContain(liveS3Config.secretAccessKey);
    const [update] = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'compliance.settings.update'))
      .orderBy(sql`${schema.auditLog.seq} desc`)
      .limit(1);
    expect((update!.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['enabled', 'schedule', 's3.secretAccessKey']),
    );
    expect(JSON.stringify(update)).not.toContain(liveS3Config.secretAccessKey);

    response = await call('POST', '/api/admin/compliance/test');
    expect(await response.json()).toMatchObject({ ok: true });

    response = await call('POST', '/api/admin/compliance/run');
    expect(response.status).toBe(202);
    let finished: { status: string; auditKey: string | null } | undefined;
    for (let attempt = 0; attempt < 120 && !finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const [row] = await pool.db.select().from(schema.complianceExportRun);
      if (row && row.status !== 'running') finished = row;
    }
    expect(finished?.status).toBe('succeeded');
    expect(finished?.auditKey).toMatch(/^via-api\//);

    response = await call('GET', '/api/admin/compliance', { user: auditor });
    const status = (await response.json()) as {
      runs: unknown[];
      lastSuccessAt: string;
      nextRunAt: string;
      holds: unknown[];
    };
    expect(status.runs).toHaveLength(1);
    expect(status.lastSuccessAt).toBeTruthy();
    expect(new Date(status.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    response = await call('GET', '/api/admin/compliance/holds', { user: auditor });
    expect(response.status).toBe(200);
  }, 30_000);

  it('reports on System health', async () => {
    const { complianceHealthCheck } = await import('../../services/observability/health-checks.js');
    state.settings.set('compliance', { enabled: false });
    expect(await complianceHealthCheck()).toMatchObject({ status: 'ok', detail: 'Off.' });

    const person = await seedUser(pool.db, state.organizationId);
    await pool.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: person,
      userEmail: 'person@example.test',
      reason: 'Matter',
    });
    expect((await complianceHealthCheck()).detail).toBe('Off. 1 person on legal hold.');

    const target = await separateTarget();
    state.settings.set('compliance', { enabled: true, ...target.settings });
    expect(await complianceHealthCheck()).toMatchObject({ status: 'warn' });
    await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(await complianceHealthCheck()).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^Last export .+audit events only/),
    });
    expect(await complianceHealthCheck(new Date(Date.now() + 3 * 86_400_000))).toMatchObject({
      status: 'warn',
    });
    state.settings.set('compliance', {
      enabled: true,
      ...target.settings,
      s3: { ...target.settings.s3, bucket: `missing-${randomUUID().slice(0, 8)}` },
    });
    // A run with nothing new writes nothing; this one has an event to write.
    await audit('health.event');
    await expect(exporter.performComplianceExport({ trigger: 'schedule' })).rejects.toThrow();
    expect(await complianceHealthCheck()).toMatchObject({ status: 'error' });

    await pool.db.delete(schema.legalHold);
  });
});

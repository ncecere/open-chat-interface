import { and, eq, schema } from '@oci/db';
import type {
  AdminGroup,
  AdminGroupDetail,
  AdminModel,
  GroupGrants,
  QuotaPolicy,
  RolesAccess,
  UsageSummary,
} from '@oci/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Actor,
  addMember,
  call,
  groupNamed,
  json,
  person,
  refusal,
} from '../../../test/groups.fixtures.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
} from '../../../test/live-postgres.js';
import { APP_VERSION } from '../../version.js';

const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  replicas: null as { version: string }[] | null,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../auth/index.js', () => ({ auth: { api: {} } }));
vi.mock('../../services/jobs/workers.js', () => ({
  liveReplicas: async () => state.replicas,
}));

describe.skipIf(!available)('live: what a group grants (budgets and models)', () => {
  let live: LiveDatabase;
  let organizationId: string;
  let admin: Actor;
  let auditor: Actor;
  let manager: Actor;
  let group: { id: string };
  let policies: { id: string; name: string }[];
  let models: { id: string; slug: string }[];

  const grants = async (id: string) => ({
    policyIds: (
      await live.db
        .select()
        .from(schema.quotaPolicyGroup)
        .where(eq(schema.quotaPolicyGroup.groupId, id))
    )
      .map((row) => row.policyId)
      .sort(),
    modelIds: (
      await live.db
        .select()
        .from(schema.modelGroupAccess)
        .where(eq(schema.modelGroupAccess.groupId, id))
    )
      .map((row) => row.modelId)
      .sort(),
  });
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const put = (id: string, body: unknown, actor: Actor = admin) =>
    call(actor, 'PUT', `/admin/groups/${id}/grants`, body);
  const auditEntries = async () =>
    (
      await live.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'group.grants.update'))
        .orderBy(schema.auditLog.seq)
    ).map((row) => row.metadata as Record<string, unknown>);

  beforeAll(async () => {
    live = await createLiveDatabase('groups_grants');
    state.db = live.db;
    organizationId = state.organizationId = await seedOrganization(live.db);
    admin = await person(live.db, organizationId, { role: 'admin' });
    auditor = await person(live.db, organizationId, { role: 'auditor' });
    manager = await person(live.db, organizationId, { role: 'user' });
    group = await groupNamed(live.db, organizationId, 'Grants');
    await addMember(live.db, group.id, manager.id, 'manager');

    policies = await live.db
      .insert(schema.quotaPolicy)
      .values(
        ['Daily A', 'Daily B', 'Daily C'].map((name) => ({
          organizationId,
          name,
          metric: 'messages' as const,
          limitValue: 10,
          windowKind: 'rolling' as const,
          windowHours: 24,
        })),
      )
      .returning({ id: schema.quotaPolicy.id, name: schema.quotaPolicy.name });
    const [provider] = await live.db
      .insert(schema.provider)
      .values({ organizationId, kind: 'openai', label: 'No calls' })
      .returning();
    models = await live.db
      .insert(schema.model)
      .values(
        ['alpha', 'beta', 'gamma'].map((slug) => ({
          organizationId,
          providerId: provider!.id,
          slug,
          upstreamModelId: slug,
          displayName: slug.toUpperCase(),
          visibleToRoles: [] as never[],
        })),
      )
      .returning({ id: schema.model.id, slug: schema.model.slug });
  });

  beforeEach(() => {
    state.replicas = null;
  });

  afterAll(async () => {
    await live.destroy();
  });

  describe('writing them from the group', () => {
    it('is for administrators only: auditors, managers and members get 403, and nothing changes', async () => {
      const body = { policyIds: [policies[0]!.id], modelIds: [models[0]!.id] };
      expect((await put(group.id, body, auditor)).status).toBe(403);
      expect((await put(group.id, body, manager)).status).toBe(403);
      expect((await call(null, 'PUT', `/admin/groups/${group.id}/grants`, body)).status).toBe(401);
      expect(await grants(group.id)).toEqual({ policyIds: [], modelIds: [] });
      // An auditor and an administrator read them; a manager does not.
      expect((await call(auditor, 'GET', `/admin/groups/${group.id}/grants`)).status).toBe(200);
      expect((await call(manager, 'GET', `/admin/groups/${group.id}/grants`)).status).toBe(403);
    });

    it('replaces both lists, names them, counts them and audits ids before and after', async () => {
      const [a, b, c] = policies;
      const [alpha, beta] = models;
      const first = await json<GroupGrants>(
        await put(group.id, { policyIds: [a!.id, b!.id], modelIds: [alpha!.id] }),
      );
      expect(first.policies.map((p) => p.name)).toEqual(['Daily A', 'Daily B']);
      expect(first.models.map((m) => m.slug)).toEqual(['alpha']);
      expect(await grants(group.id)).toEqual({
        policyIds: ids([a!, b!]),
        modelIds: ids([alpha!]),
      });

      // A second PUT replaces: one policy goes, another comes, the model changes.
      await json<GroupGrants>(
        await put(group.id, { policyIds: [b!.id, c!.id], modelIds: [beta!.id] }),
      );
      expect(await grants(group.id)).toEqual({
        policyIds: ids([b!, c!]),
        modelIds: ids([beta!]),
      });
      const detail = await json<AdminGroupDetail>(
        await call(admin, 'GET', `/admin/groups/${group.id}`),
      );
      expect(detail).toMatchObject({ policyCount: 2, modelCount: 1 });

      const entries = await auditEntries();
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        policyIds: { before: ids([a!, b!]), after: ids([b!, c!]) },
        modelIds: { before: ids([alpha!]), after: ids([beta!]) },
      });
    });

    it('leaves the rows and the audit log alone when nothing changes', async () => {
      const current = await grants(group.id);
      const before = (await auditEntries()).length;
      const rows = await live.db
        .select()
        .from(schema.quotaPolicyGroup)
        .where(eq(schema.quotaPolicyGroup.groupId, group.id));
      await json<GroupGrants>(await put(group.id, current));
      expect((await auditEntries()).length).toBe(before);
      const after = await live.db
        .select()
        .from(schema.quotaPolicyGroup)
        .where(eq(schema.quotaPolicyGroup.groupId, group.id));
      expect(after.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
    });

    it('needs both lists, so a client that omits one cannot clear it', async () => {
      const before = await grants(group.id);
      expect((await put(group.id, { policyIds: [] })).status).toBe(422);
      expect((await put(group.id, { modelIds: [] })).status).toBe(422);
      expect((await put(group.id, {})).status).toBe(422);
      expect((await put(group.id, { policyIds: [], modelIds: [], extra: 1 })).status).toBe(422);
      expect(await grants(group.id)).toEqual(before);
    });

    it('refuses a budget or model that does not exist, naming it, and changes nothing', async () => {
      const before = await grants(group.id);
      const error = await refusal(
        await put(group.id, { policyIds: [policies[0]!.id, 'no-such-policy'], modelIds: [] }),
        422,
      );
      expect(error.details).toMatchObject({ reason: 'unknown_grant', ids: ['no-such-policy'] });
      const other = await refusal(
        await put(group.id, { policyIds: [], modelIds: ['no-such-model'] }),
        422,
      );
      expect(other.details).toMatchObject({ reason: 'unknown_grant', ids: ['no-such-model'] });
      expect(await grants(group.id)).toEqual(before);
    });

    it('clears both with two empty lists, 404 for an unknown group', async () => {
      const scratch = await groupNamed(live.db, organizationId, 'Scratch');
      await put(scratch.id, { policyIds: [policies[0]!.id], modelIds: [models[0]!.id] });
      await json<GroupGrants>(await put(scratch.id, { policyIds: [], modelIds: [] }));
      expect(await grants(scratch.id)).toEqual({ policyIds: [], modelIds: [] });
      expect((await put('nope', { policyIds: [], modelIds: [] })).status).toBe(404);
    });

    it('waits for an upgrade in progress: 409 while an older replica serves, nothing written', async () => {
      const scratch = await groupNamed(live.db, organizationId, 'Mixed versions');
      // Relative to the running release, whatever it is: a replica two minors back is older,
      // the same minor (any patch) and later ones are not.
      const [major, minor] = APP_VERSION.split('.').map(Number) as [number, number];
      state.replicas = [{ version: `${major}.${minor - 2}.9` }, { version: APP_VERSION }];
      const error = await refusal(
        await put(scratch.id, { policyIds: [policies[0]!.id], modelIds: [] }),
        409,
      );
      expect(error.message).toBe('An upgrade is still in progress');
      expect(error.details).toMatchObject({ reason: 'upgrade_in_progress' });
      expect(await grants(scratch.id)).toEqual({ policyIds: [], modelIds: [] });
      // Reads and member changes are not held; same-minor replicas and no heartbeats are fine.
      expect((await call(admin, 'GET', `/admin/groups/${scratch.id}/grants`)).status).toBe(200);
      state.replicas = [
        { version: APP_VERSION },
        { version: `${major}.${minor}.99` },
        { version: `${major}.${minor + 1}.0` },
      ];
      expect((await put(scratch.id, { policyIds: [], modelIds: [] })).status).toBe(200);
      state.replicas = null;
      expect((await put(scratch.id, { policyIds: [], modelIds: [] })).status).toBe(200);
    });
  });

  describe('never through the budget or model forms', () => {
    it('keeps a budget’s groups when its form is saved without them, and refuses groupIds', async () => {
      const scratch = await groupNamed(live.db, organizationId, 'Form safe');
      const policy = policies[0]!;
      await put(scratch.id, { policyIds: [policy.id], modelIds: [] });
      const [current] = await json<{ policies: QuotaPolicy[] }>(
        await call(admin, 'GET', '/admin/quotas'),
      ).then((body) => body.policies.filter((p) => p.id === policy.id));
      expect(current?.groups).toEqual(
        expect.arrayContaining([{ id: scratch.id, name: 'Form safe' }]),
      );

      // The form's PUT: a body that does not know about groups.
      await json(
        await call(admin, 'PUT', `/admin/quotas/${policy.id}`, {
          name: 'Daily A',
          metric: 'messages',
          limitValue: 25,
          windowKind: 'rolling',
          windowHours: 24,
          timezone: 'UTC',
          enabled: true,
          roles: ['user'],
          modelSlugs: [],
        }),
      );
      expect((await grants(scratch.id)).policyIds).toEqual([policy.id]);
      // And a client that tries to send them is refused, not obeyed.
      const refused = await call(admin, 'PUT', `/admin/quotas/${policy.id}`, {
        name: 'Daily A',
        metric: 'messages',
        limitValue: 25,
        windowKind: 'rolling',
        windowHours: 24,
        timezone: 'UTC',
        enabled: true,
        roles: ['user'],
        modelSlugs: [],
        groupIds: [],
      });
      expect(refused.status).toBe(422);
      expect((await grants(scratch.id)).policyIds).toEqual([policy.id]);
    });

    it('shows groups as read-only chips on budgets and models', async () => {
      const scratch = await groupNamed(live.db, organizationId, 'Chips');
      await put(scratch.id, { policyIds: [policies[1]!.id], modelIds: [models[2]!.id] });
      const budgets = await json<{ policies: QuotaPolicy[] }>(
        await call(admin, 'GET', '/admin/quotas'),
      );
      expect(budgets.policies.find((p) => p.id === policies[1]!.id)?.groups).toEqual(
        expect.arrayContaining([{ id: scratch.id, name: 'Chips' }]),
      );
      expect(budgets.policies.find((p) => p.id === policies[2]!.id)?.groups).toBeDefined();
      const catalog = await json<{ models: AdminModel[] }>(
        await call(admin, 'GET', '/admin/models'),
      );
      expect(catalog.models.find((m) => m.id === models[2]!.id)?.groups).toEqual([
        { id: scratch.id, name: 'Chips' },
      ]);
      expect(catalog.models.find((m) => m.id === models[0]!.id)?.groups).toEqual(expect.any(Array));
    });
  });

  describe('what an administrator sees of a person', () => {
    it('names where each budget comes from in the limits, and lists the groups', async () => {
      const subject = await person(live.db, organizationId, { role: 'user' });
      const g1 = await groupNamed(live.db, organizationId, 'Source one');
      const g2 = await groupNamed(live.db, organizationId, 'Source two');
      await addMember(live.db, g1.id, subject.id);
      await addMember(live.db, g2.id, subject.id);
      const [role, groupOnly] = await live.db
        .insert(schema.quotaPolicy)
        .values(
          ['Source by role', 'Source by group'].map((name) => ({
            organizationId,
            name,
            metric: 'messages' as const,
            limitValue: 5,
            windowKind: 'rolling' as const,
            windowHours: 24,
          })),
        )
        .returning();
      await live.db.insert(schema.quotaPolicyRole).values({ policyId: role!.id, role: 'user' });
      // Both ways at once, and the other budget by two groups.
      await live.db.insert(schema.quotaPolicyGroup).values([
        { policyId: role!.id, groupId: g1.id },
        { policyId: groupOnly!.id, groupId: g1.id },
        { policyId: groupOnly!.id, groupId: g2.id },
      ]);

      const body = await json<{
        usage: UsageSummary;
        budgetSources: Record<string, Array<{ kind: string; groupName?: string }>>;
      }>(await call(auditor, 'GET', `/admin/users/${subject.id}/limits`));
      expect(body.usage.allowances.filter((a) => a.policyId === role!.id)).toHaveLength(1);
      expect(body.budgetSources[role!.id]).toEqual([
        { kind: 'role' },
        { kind: 'group', groupId: g1.id, groupName: 'Source one' },
      ]);
      expect(body.budgetSources[groupOnly!.id]).toEqual([
        { kind: 'group', groupId: g1.id, groupName: 'Source one' },
        { kind: 'group', groupId: g2.id, groupName: 'Source two' },
      ]);
    });

    it('lets an administrator override a budget the person has only through a group', async () => {
      const subject = await person(live.db, organizationId, { role: 'restricted' });
      const g = await groupNamed(live.db, organizationId, 'Override group');
      await addMember(live.db, g.id, subject.id);
      await live.db
        .insert(schema.quotaPolicyGroup)
        .values({ policyId: policies[2]!.id, groupId: g.id });
      const ok = await call(admin, 'PUT', `/admin/users/${subject.id}/quota-overrides`, {
        policyId: policies[2]!.id,
        limitValue: 99,
        reason: 'research',
      });
      expect(ok.status).toBe(200);
      // A budget they have no way to is still refused.
      const other = await groupNamed(live.db, organizationId, 'Not theirs');
      await live.db
        .insert(schema.quotaPolicyGroup)
        .values({ policyId: policies[0]!.id, groupId: other.id });
      const refused = await call(admin, 'PUT', `/admin/users/${subject.id}/quota-overrides`, {
        policyId: policies[0]!.id,
        limitValue: 99,
      });
      expect(refused.status).toBe(422);
      const listed = await json<{ overrides: { policyId: string; limitValue: number }[] }>(
        await call(admin, 'GET', `/admin/users/${subject.id}/quota-overrides`),
      );
      expect(listed.overrides.map((o) => o.policyId)).toContain(policies[2]!.id);
      expect(
        await live.db
          .select()
          .from(schema.quotaPolicyOverride)
          .where(
            and(
              eq(schema.quotaPolicyOverride.userId, subject.id),
              eq(schema.quotaPolicyOverride.policyId, policies[0]!.id),
            ),
          ),
      ).toHaveLength(0);
    });
  });

  it('lists groups in the list view with their grant counts', async () => {
    const page = await json<{ groups: AdminGroup[] }>(
      await call(admin, 'GET', '/admin/groups?search=grants'),
    );
    expect(page.groups[0]).toMatchObject({ name: 'Grants', policyCount: 2, modelCount: 1 });
  });

  it('keeps the roles summary working with groups present (the Groups section is in the next test file)', async () => {
    const body = await json<RolesAccess>(await call(admin, 'GET', '/admin/roles'));
    expect(body.roles).toHaveLength(4);
  });
});

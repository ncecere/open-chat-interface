import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBucket, liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Deletions in the compliance export (v0.10): every path that moves a
 * person's data to the trash, restores it or deletes it writes one normalised
 * audit entry in the same transaction, and the export's audit stream carries
 * those entries exactly once across runs and restarts, never with content.
 * Real PostgreSQL, MinIO as the destination.
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
}));
// Queued webhooks are inspected in the table, never sent.
vi.mock('../../services/jobs/index.js', () => ({ runJobNow: async () => null }));

const available = (await livePostgresAvailable()) && (await liveS3Available());
const DAY = 86_400_000;
const old = () => new Date(Date.now() - 400 * DAY);

/** Words that would only appear in an entry if content leaked into it. */
const CONTENT = ['Secret merger plan', 'board-minutes.pdf', 'Project Falcon', 'Allergic to nuts'];

type Entry = typeof schema.auditLog.$inferSelect;
type Deletion = {
  type: string;
  id: string;
  ownerUserId: string;
  ownerEmail: string | null;
  reason: string;
  permanent: boolean;
  [key: string]: unknown;
};
const deletionOf = (entry: { metadata: unknown }) =>
  (entry.metadata as { deletion?: Deletion } | null)?.deletion;

describe.skipIf(!available)('live: deletions in the compliance export', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let person: string;
  let encrypt: (value: string) => string;
  let S3: typeof import('../../services/storage/s3-driver.js').S3StorageDriver;

  const exists = async (table: string, id: string) =>
    (await pool.db.execute(sql`select 1 from ${sql.identifier(table)} where id = ${id}`)).length >
    0;

  async function thread(
    userId: string,
    fields: { deletedAt?: Date; temporary?: boolean; expiresAt?: Date; lastMessageAt?: Date } = {},
  ): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title, temporary, expires_at, deleted_at,
        deleted_reason, last_message_at, created_at)
      values (${state.organizationId}, ${userId}, ${CONTENT[0]}, ${fields.temporary ?? false},
        ${fields.expiresAt?.toISOString() ?? null}::timestamptz,
        ${fields.deletedAt?.toISOString() ?? null}::timestamptz,
        ${fields.deletedAt ? 'user' : null}, ${fields.lastMessageAt?.toISOString() ?? null}::timestamptz,
        ${(fields.lastMessageAt ?? new Date()).toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  /** A conversation with two messages, one file and one artifact. */
  async function fullThread(userId: string, fields: Parameters<typeof thread>[1] = {}) {
    const id = await thread(userId, fields);
    const [first] = await pool.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, status)
      values (${id}, ${userId}, 'user', ${JSON.stringify([{ type: 'text', text: CONTENT[0] }])}::jsonb, 'complete')
      returning id`);
    const [reply] = await pool.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, status, parent_message_id)
      values (${id}, ${userId}, 'assistant', '[{"type":"text","text":"Noted."}]'::jsonb, 'complete', ${first!.id})
      returning id`);
    const file = await attachment(userId, { messageId: first!.id });
    await pool.db.execute(sql`
      insert into artifact (user_id, thread_id, message_id, source_key, title, kind)
      values (${userId}, ${id}, ${reply!.id}, 'a1', ${CONTENT[2]}, 'html')`);
    return { id, messageId: first!.id, file };
  }

  async function attachment(
    userId: string,
    owner: { messageId?: string; projectId?: string },
    deletedAt?: Date,
  ): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into attachment (organization_id, user_id, message_id, project_id, filename, mime_type,
        size_bytes, storage_key, deleted_at, deleted_reason)
      values (${state.organizationId}, ${userId}, ${owner.messageId ?? null}, ${owner.projectId ?? null},
        ${CONTENT[1]}, 'application/pdf', 1234, ${`test/${randomUUID()}`},
        ${deletedAt?.toISOString() ?? null}::timestamptz, ${deletedAt ? 'user' : null})
      returning id`);
    return row!.id;
  }

  async function project(userId: string): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into project (organization_id, user_id, name) values (${state.organizationId}, ${userId}, ${CONTENT[2]})
      returning id`);
    return row!.id;
  }

  async function memory(userId: string, updatedAt = new Date()): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into user_memory (user_id, content, source, created_at, updated_at)
      values (${userId}, ${CONTENT[3]}, 'person', ${updatedAt.toISOString()}::timestamptz,
        ${updatedAt.toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  async function deletionEntries(): Promise<Entry[]> {
    const rows = await pool.db.select().from(schema.auditLog).orderBy(schema.auditLog.seq);
    return rows.filter((row) => deletionOf(row));
  }

  beforeAll(async () => {
    live = await createLiveDatabase('compliance_deletions');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.env = { DATABASE_URL: live.connectionString };
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, {
      role: 'admin',
      email: 'admin@example.test',
    });
    ({ encryptSecret: encrypt } = await import('../../lib/crypto.js'));
    ({ S3StorageDriver: S3 } = await import('../../services/storage/s3-driver.js'));
  });

  beforeEach(async () => {
    state.settings.clear();
    state.settings.set('retention', {
      threadRetentionDays: 30,
      trashRetentionDays: 7,
      memoryRetentionDays: 30,
      exemptPinnedThreads: false,
    });
    person = await seedUser(pool.db, state.organizationId, {
      email: `person-${randomUUID().slice(0, 6)}@example.test`,
    });
    await pool.db.delete(schema.auditLog);
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  it('records one normalised event for every way data is trashed, restored or deleted', async () => {
    const trash = await import('../../services/lifecycle/trash.js');
    const retention = await import('../../services/lifecycle/retention.js');
    const threads = await import('../../services/threads.js');
    const projects = await import('../../services/projects.js');
    const memories = await import('../../services/memory/store.js');
    const attachments = await import('../../services/attachments/index.js');
    const users = await import('../../services/admin-users/mutations.js');

    // Owner actions.
    const trashed = await fullThread(person);
    await trash.softDeleteThread(trashed.id, person);
    await trash.restoreThread(trashed.id, person);
    await trash.softDeleteThread(trashed.id, person);
    await trash.purgeTrashedThread(trashed.id, person);
    const emptied = await thread(person, { deletedAt: new Date() });
    await trash.emptyTrash(person);
    const chat = await fullThread(person);
    await attachments.deleteAttachment(chat.file, person);
    const projectId = await project(person);
    const projectFile = await attachment(person, { projectId });
    const keptFile = await attachment(person, { projectId });
    await projects.deleteProjectFile(projectId, projectFile, person);
    await projects.deleteProject(projectId, person);
    const note = await memory(person);
    await memories.deleteMemory(person, note, 'settings');
    const forgotten = await memory(person);
    await memories.forgetMemory(person, forgotten.slice(0, 8), {
      threadId: chat.id,
      messageId: chat.messageId,
    });
    const all = [await memory(person), await memory(person)];
    expect(await memories.deleteAllMemories(person)).toBe(2);

    // Background jobs (no actor).
    const inactive = await thread(person, { lastMessageAt: old() });
    expect(await retention.applyThreadRetention()).toBe(1);
    const expired = await fullThread(person, { deletedAt: old() });
    const loose = await attachment(
      person,
      { messageId: (await fullThread(person)).messageId },
      old(),
    );
    const temporary = await thread(person, { temporary: true, expiresAt: old() });
    const opened = await thread(person, { temporary: true, expiresAt: old() });
    await expect(threads.getOwnedThread(opened, person)).rejects.toMatchObject({ status: 404 });
    expect(await threads.purgeExpiredTemporaryThreads()).toBe(1);
    // The retention-trashed conversation is fresh in the trash: not purged.
    expect(await trash.purgeExpiredTrash()).toBe(2);
    const stale = await memory(person, old());
    expect(await memories.applyMemoryRetention()).toBe(1);

    // An administrator deletes the account, and everything left with it.
    const leftover = await fullThread(person);
    await users.deleteUser({ id: admin, email: 'admin@example.test' }, person);
    expect(await exists('thread', leftover.id)).toBe(false);

    const entries = await deletionEntries();
    const row = (entry: Entry) => {
      const deletion = deletionOf(entry)!;
      return [entry.action, deletion.id, deletion.reason, entry.actorUserId ? 'actor' : 'system'];
    };
    // "Delete all" records one event per note, in no particular order.
    const summary = entries.filter((entry) => !all.includes(deletionOf(entry)!.id)).map(row);
    expect(
      entries
        .filter((entry) => all.includes(deletionOf(entry)!.id))
        .map(row)
        .sort(),
    ).toEqual(
      all
        .slice()
        .sort()
        .map((id) => ['memory.delete', id, 'user', 'system']),
    );
    // The account deletion set the owner's own entries' actor to null (the
    // foreign key), but each entry still names the owner and their email.
    expect(summary).toEqual([
      ['conversation.trash', trashed.id, 'user', 'system'],
      ['conversation.restore', trashed.id, 'user', 'system'],
      ['conversation.trash', trashed.id, 'user', 'system'],
      ['conversation.delete', trashed.id, 'user', 'system'],
      ['conversation.delete', emptied, 'user', 'system'],
      ['attachment.trash', chat.file, 'user', 'system'],
      ['attachment.delete', projectFile, 'user', 'system'],
      ['project.delete', projectId, 'user', 'system'],
      ['memory.delete', note, 'user', 'system'],
      ['memory.delete', forgotten, 'tool', 'system'],
      ['conversation.trash', inactive, 'retention', 'system'],
      ['conversation.delete', opened, 'temporary_expiry', 'system'],
      ['conversation.delete', temporary, 'temporary_expiry', 'system'],
      ['conversation.delete', expired.id, 'trash_expiry', 'system'],
      ['attachment.delete', loose, 'trash_expiry', 'system'],
      ['memory.delete', stale, 'retention', 'system'],
      ['user.delete', person, 'admin', 'actor'],
    ]);

    // Who: the owner's email survives the account; the admin is the actor.
    for (const entry of entries) {
      expect(deletionOf(entry)).toMatchObject({
        ownerUserId: person,
        ownerEmail: expect.any(String),
      });
      const system = ['retention', 'trash_expiry', 'temporary_expiry'].includes(
        deletionOf(entry)!.reason,
      );
      if (entry.action === 'user.delete') expect(entry.actorEmail).toBe('admin@example.test');
      else expect(entry.actorEmail).toBe(system ? null : deletionOf(entry)!.ownerEmail);
    }
    const byAction = (action: string, id: string) =>
      entries.find((entry) => entry.action === action && deletionOf(entry)!.id === id)!;
    // What went with it, counted; permanent only when destroyed.
    expect(deletionOf(byAction('conversation.delete', trashed.id))).toMatchObject({
      type: 'conversation',
      permanent: true,
      messages: 2,
      attachments: 1,
      artifacts: 1,
      temporary: false,
    });
    expect(deletionOf(byAction('conversation.trash', trashed.id))).toMatchObject({
      permanent: false,
      attachments: 1,
    });
    expect(deletionOf(byAction('attachment.trash', chat.file))).toMatchObject({
      threadId: chat.id,
      messageId: chat.messageId,
      sizeBytes: 1234,
      permanent: false,
    });
    expect(deletionOf(byAction('project.delete', projectId))).toMatchObject({
      files: 1,
      fileIds: [keptFile],
      conversationsDetached: 0,
    });
    expect(deletionOf(byAction('user.delete', person))).toMatchObject({
      type: 'user',
      // The conversation with a trashed file, the one retention trashed, the
      // one that held the purged loose file, and the last one.
      conversations: 4,
      messages: 6,
      attachments: 3,
      artifacts: 3,
      projects: 0,
      memories: 0,
    });
    expect(byAction('user.delete', person).metadata).toMatchObject({ role: 'user' });
    // Memory entries keep their v0.9 shape too.
    expect(byAction('memory.delete', forgotten)).toMatchObject({
      targetType: 'user',
      targetId: person,
      metadata: { count: 1, via: 'tool', memoryId: forgotten, threadId: chat.id },
    });

    // Never content: no titles, file names, project names or memory text.
    const serialized = JSON.stringify(entries);
    for (const word of CONTENT) expect(serialized).not.toContain(word);
  });

  it('writes the event in the deleting transaction: no event, no deletion', async () => {
    const trash = await import('../../services/lifecycle/trash.js');
    await pool.db.insert(schema.webhookEndpoint).values({
      organizationId: state.organizationId,
      url: 'https://hooks.example.test/oci',
      actions: ['conversation.*'],
      encryptedSecret: encrypt('whsec-test'),
    });
    const kept = await thread(person, { deletedAt: new Date() });
    await pool.db.execute(sql`
      create function refuse_conversation_delete() returns trigger as $$
      begin
        if new.action = 'conversation.delete' then raise exception 'audit unavailable'; end if;
        return new;
      end $$ language plpgsql`);
    await pool.db.execute(sql`
      create trigger refuse_conversation_delete before insert on audit_log
      for each row execute function refuse_conversation_delete()`);
    try {
      await expect(trash.purgeTrashedThread(kept, person)).rejects.toThrow();
      expect(await exists('thread', kept)).toBe(true);
      expect(await pool.db.select().from(schema.webhookDelivery)).toEqual([]);
    } finally {
      await pool.db.execute(sql`drop trigger refuse_conversation_delete on audit_log`);
      await pool.db.execute(sql`drop function refuse_conversation_delete()`);
    }

    // Once it can be recorded, it goes, and its webhook is queued with it.
    await trash.purgeTrashedThread(kept, person);
    expect(await exists('thread', kept)).toBe(false);
    const [entry] = await deletionEntries();
    const deliveries = await pool.db.select().from(schema.webhookDelivery);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ auditLogId: entry!.id, event: 'conversation.delete' });
    expect(JSON.parse(deliveries[0]!.body)).toMatchObject({
      type: 'conversation.delete',
      target: { type: 'conversation', id: kept },
      metadata: { deletion: { ownerUserId: person, permanent: true } },
    });
    await pool.db.delete(schema.webhookDelivery);
    await pool.db.delete(schema.webhookEndpoint);
  });

  it('keeps deletion events about a held person from audit retention', async () => {
    const retention = await import('../../services/lifecycle/retention.js');
    const trash = await import('../../services/lifecycle/trash.js');
    state.settings.set('retention', { auditLogRetentionDays: 30, trashRetentionDays: 7 });
    const other = await seedUser(pool.db, state.organizationId);
    await thread(person, { deletedAt: old() });
    await thread(other, { deletedAt: old() });
    expect(await trash.purgeExpiredTrash()).toBe(2);
    // Backdate the (system) events, then hold one owner.
    await pool.db.execute(
      sql`update audit_log set created_at = ${old().toISOString()}::timestamptz`,
    );
    await pool.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: person,
      userEmail: 'person@example.test',
      reason: 'Matter 9',
    });
    try {
      await retention.pruneAuditLog();
      const owners = (await deletionEntries()).map((entry) => deletionOf(entry)!.ownerUserId);
      expect(owners).toEqual([person]);
    } finally {
      await pool.db.delete(schema.legalHold);
    }
  });

  it('exports deletion events exactly once across runs and a restart, never with content', async () => {
    const bucket = `oci-test-deletions-${randomUUID().slice(0, 8)}`;
    await ensureBucket(bucket);
    const driver = new S3({ ...liveS3Config, bucket });
    state.settings.set('compliance', {
      enabled: true,
      // Content on: the message stream may carry titles; deletion events still never do.
      includeContent: true,
      destination: 'separate',
      prefix: 'records/',
      s3: {
        bucket,
        region: 'us-east-1',
        endpoint: liveS3Config.endpoint,
        accessKeyId: liveS3Config.accessKeyId,
        encryptedSecretAccessKey: encrypt(liveS3Config.secretAccessKey),
        forcePathStyle: true,
      },
    });
    await pool.db.delete(schema.complianceExportRun);
    await pool.db.delete(schema.complianceExportCursor);
    const trash = await import('../../services/lifecycle/trash.js');
    const memories = await import('../../services/memory/store.js');
    let exporter = await import('../../services/compliance/export.js');

    const first = await fullThread(person, { deletedAt: new Date() });
    await trash.purgeTrashedThread(first.id, person);
    const runOne = await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(runOne).toMatchObject({ status: 'succeeded' });

    const second = await fullThread(person);
    await trash.softDeleteThread(second.id, person);
    await memories.deleteMemory(person, await memory(person), 'settings');

    // A restart: the module is loaded afresh and continues from the cursor.
    vi.resetModules();
    exporter = await import('../../services/compliance/export.js');
    const runTwo = await exporter.performComplianceExport({ trigger: 'schedule' });
    const runThree = await exporter.performComplianceExport({ trigger: 'schedule' });
    expect(runThree).toMatchObject({ status: 'succeeded', auditCount: 0 });

    const lines: Array<Record<string, unknown>> = [];
    for (const run of [runOne, runTwo]) {
      const body = (await driver.get(run.auditKey!)).toString('utf8');
      for (const word of CONTENT) expect(body).not.toContain(word);
      lines.push(
        ...body
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    }
    const exported = lines.filter((line) => deletionOf(line as { metadata: unknown }));
    expect(
      exported.map((line) => [line.action, deletionOf(line as { metadata: unknown })!.id]),
    ).toEqual([
      ['conversation.delete', first.id],
      ['conversation.trash', second.id],
      ['memory.delete', expect.any(String)],
    ]);
    // Exactly once: every deletion entry in the database, each in one object.
    const ids = (await deletionEntries()).map((entry) => entry.id);
    expect(exported.map((line) => line.id)).toEqual(ids);
    expect(exported[0]).toMatchObject({
      actorUserId: person,
      targetType: 'conversation',
      targetId: first.id,
      createdAt: expect.any(String),
      metadata: {
        deletion: {
          type: 'conversation',
          ownerUserId: person,
          reason: 'user',
          permanent: true,
          messages: 2,
          attachments: 1,
          artifacts: 1,
        },
      },
    });

    for (const key of (await driver.list({})).objects.map((object) => object.key))
      await driver.delete(key);
  });

  it('exports what each entry already carries, so the event list is complete', async () => {
    const { DELETION_ACTIONS } = await import('../../services/compliance/deletions.js');
    expect([...DELETION_ACTIONS].sort()).toEqual([
      'attachment.delete',
      'attachment.trash',
      'conversation.delete',
      'conversation.restore',
      'conversation.trash',
      'memory.delete',
      'project.delete',
      'user.delete',
    ]);
    // A path that did nothing records nothing.
    const trash = await import('../../services/lifecycle/trash.js');
    expect(await trash.emptyTrash(person)).toBe(0);
    await expect(trash.purgeTrashedThread(randomUUID(), person)).rejects.toMatchObject({
      status: 404,
    });
    expect(await deletionEntries()).toEqual([]);
    expect(
      await pool.db.select().from(schema.auditLog).where(eq(schema.auditLog.actorUserId, person)),
    ).toEqual([]);
  });
});

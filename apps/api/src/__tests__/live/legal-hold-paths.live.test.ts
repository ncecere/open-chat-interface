import { randomUUID } from 'node:crypto';
import { createDatabase, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Legal hold covers every deletion path (v0.10). One row per path that can
 * remove a person's data: each is run once for a person on hold and once for
 * a person who is not, against real PostgreSQL, so the table shows both that
 * the hold is checked and that the check is about the hold.
 *
 * `refused`: the call fails with 409 and the data stays.
 * `skipped`: the job runs and leaves the held person's data alone.
 * `kept`: the call succeeds for its caller, but keeps the data.
 *
 * Paths that may delete without checking (pending uploads, provisional reply
 * rows, released reservations, import uploads, sessions) are listed with the
 * reason in `__tests__/unit/legal-hold-paths.unit.test.ts`, which also fails
 * when a new deletion appears in the code without being classified.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  settings: new Map<string, unknown>(),
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async (key: string) => structuredClone(state.settings.get(key) ?? {}),
}));

const available = await livePostgresAvailable();
const DAY = 86_400_000;
const old = () => new Date(Date.now() - 400 * DAY);

type Outcome = 'refused' | 'skipped' | 'kept';
interface HoldPath {
  path: string;
  outcome: Outcome;
  /** Creates the data for one person; returns whatever `act` and `present` need. */
  seed: (userId: string) => Promise<string>;
  act: (userId: string, handle: string) => Promise<unknown>;
  /** True while the data is still there. */
  present: (handle: string) => Promise<boolean>;
}

describe.skipIf(!available)('live: legal hold covers every deletion path', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let admin: string;
  let held: string;
  let free: string;

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
      values (${state.organizationId}, ${userId}, 'Held matter', ${fields.temporary ?? false},
        ${fields.expiresAt?.toISOString() ?? null}::timestamptz,
        ${fields.deletedAt?.toISOString() ?? null}::timestamptz,
        ${fields.deletedAt ? 'user' : null}, ${fields.lastMessageAt?.toISOString() ?? null}::timestamptz,
        ${(fields.lastMessageAt ?? new Date()).toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  async function message(threadId: string, userId: string): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, status)
      values (${threadId}, ${userId}, 'user', '[{"type":"text","text":"hello"}]'::jsonb, 'complete')
      returning id`);
    return row!.id;
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
        'evidence.txt', 'text/plain', 12, ${`test/${randomUUID()}`},
        ${deletedAt?.toISOString() ?? null}::timestamptz, ${deletedAt ? 'user' : null})
      returning id`);
    return row!.id;
  }

  async function project(userId: string): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into project (organization_id, user_id, name) values (${state.organizationId}, ${userId}, 'Matter files')
      returning id`);
    return row!.id;
  }

  async function memory(userId: string, updatedAt = new Date()): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into user_memory (user_id, content, source, created_at, updated_at)
      values (${userId}, 'Prefers metric units', 'person', ${updatedAt.toISOString()}::timestamptz,
        ${updatedAt.toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  async function auditEntry(owner: string): Promise<string> {
    const [row] = await pool.db.execute<{ id: string }>(sql`
      insert into audit_log (organization_id, actor_user_id, action, target_type, target_id, metadata, created_at)
      values (${state.organizationId}, null, 'conversation.delete', 'conversation', ${randomUUID()},
        ${JSON.stringify({ deletion: { type: 'conversation', ownerUserId: owner } })}::jsonb,
        ${old().toISOString()}::timestamptz)
      returning id`);
    return row!.id;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('legal_hold_paths');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    admin = await seedUser(pool.db, state.organizationId, { role: 'admin', email: 'a@x.test' });
  });

  beforeEach(async () => {
    state.settings.clear();
    state.settings.set('retention', {
      threadRetentionDays: 30,
      trashRetentionDays: 7,
      auditLogRetentionDays: 30,
      usageEventRetentionDays: 30,
      memoryRetentionDays: 30,
      exemptPinnedThreads: false,
    });
    // Fresh people for every path, so one path's data never satisfies another's.
    held = await seedUser(pool.db, state.organizationId);
    free = await seedUser(pool.db, state.organizationId);
    await pool.db.insert(schema.legalHold).values({
      organizationId: state.organizationId,
      userId: held,
      userEmail: 'held@x.test',
      reason: 'Matter 2026-41',
    });
  });

  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const services = async () => ({
    projects: await import('../../services/projects.js'),
    trash: await import('../../services/lifecycle/trash.js'),
    retention: await import('../../services/lifecycle/retention.js'),
    threads: await import('../../services/threads.js'),
    memory: await import('../../services/memory/store.js'),
    users: await import('../../services/admin-users/mutations.js'),
    attachments: await import('../../services/attachments/index.js'),
  });

  const PATHS: HoldPath[] = [
    {
      path: 'Deleting a project (DELETE /api/projects/:id): its files',
      outcome: 'refused',
      seed: async (user) => attachment(user, { projectId: await project(user) }),
      act: async (user, file) => {
        const [row] = await pool.db.execute<{ project_id: string }>(
          sql`select project_id from attachment where id = ${file}`,
        );
        return (await services()).projects.deleteProject(row!.project_id, user);
      },
      present: (file) => exists('attachment', file),
    },
    {
      path: 'Deleting a project file (DELETE /api/projects/:id/files/:fileId)',
      outcome: 'refused',
      seed: async (user) => attachment(user, { projectId: await project(user) }),
      act: async (user, file) => {
        const [row] = await pool.db.execute<{ project_id: string }>(
          sql`select project_id from attachment where id = ${file}`,
        );
        return (await services()).projects.deleteProjectFile(row!.project_id, file, user);
      },
      present: (file) => exists('attachment', file),
    },
    {
      path: 'Usage-event pruning (retention.usage-events)',
      outcome: 'skipped',
      seed: async (user) => {
        const [row] = await pool.db.execute<{ id: string }>(sql`
          insert into usage_event (organization_id, user_id, model_slug, occurred_at)
          values (${state.organizationId}, ${user}, 'test-model', ${old().toISOString()}::timestamptz)
          returning id`);
        return row!.id;
      },
      act: async () => (await services()).retention.pruneUsageEvents(),
      present: (id) => exists('usage_event', id),
    },
    {
      path: 'Share-link pruning (retention.share-links)',
      outcome: 'skipped',
      seed: async (user) => {
        const [row] = await pool.db.execute<{ id: string }>(sql`
          insert into share_link (thread_id, user_id, slug, expires_at)
          values (${await thread(user)}, ${user}, ${randomUUID()}, ${old().toISOString()}::timestamptz)
          returning id`);
        return row!.id;
      },
      act: async () => (await services()).retention.pruneShareLinks(),
      present: (id) => exists('share_link', id),
    },
    {
      path: 'Conversation retention (retention.threads)',
      outcome: 'skipped',
      seed: (user) => thread(user, { lastMessageAt: old() }),
      act: async () => (await services()).retention.applyThreadRetention(),
      present: async (id) =>
        (await pool.db.execute(sql`select 1 from thread where id = ${id} and deleted_at is null`))
          .length > 0,
    },
    {
      path: 'Trash purge: conversations (trash.purge-expired)',
      outcome: 'skipped',
      seed: (user) => thread(user, { deletedAt: old() }),
      act: async () => (await services()).trash.purgeExpiredTrash(),
      present: (id) => exists('thread', id),
    },
    {
      path: 'Trash purge: files trashed on their own (trash.purge-expired)',
      outcome: 'skipped',
      seed: async (user) =>
        attachment(user, { messageId: await message(await thread(user), user) }, old()),
      act: async () => (await services()).trash.purgeExpiredTrash(),
      present: (id) => exists('attachment', id),
    },
    {
      path: 'Temporary chat expiry (threads.purge-temporary)',
      outcome: 'skipped',
      seed: (user) => thread(user, { temporary: true, expiresAt: old() }),
      act: async () => (await services()).threads.purgeExpiredTemporaryThreads(),
      present: (id) => exists('thread', id),
    },
    {
      path: 'Opening an expired temporary chat (deleted on access)',
      outcome: 'kept',
      seed: (user) => thread(user, { temporary: true, expiresAt: old() }),
      act: async (user, id) =>
        (await services()).threads.getOwnedThread(id, user).catch((error: { status?: number }) => {
          // Not found for its owner either way: expired chats stay invisible.
          expect(error.status).toBe(404);
        }),
      present: (id) => exists('thread', id),
    },
    {
      path: 'Delete forever (DELETE /api/threads/:id/permanent)',
      outcome: 'refused',
      seed: (user) => thread(user, { deletedAt: new Date() }),
      act: async (user, id) => (await services()).trash.purgeTrashedThread(id, user),
      present: (id) => exists('thread', id),
    },
    {
      path: 'Empty trash (DELETE /api/threads/trash)',
      outcome: 'refused',
      seed: (user) => thread(user, { deletedAt: new Date() }),
      act: async (user) => (await services()).trash.emptyTrash(user),
      present: (id) => exists('thread', id),
    },
    {
      path: 'Deleting a memory (DELETE /api/memory/:id)',
      outcome: 'refused',
      seed: (user) => memory(user),
      act: async (user, id) => (await services()).memory.deleteMemory(user, id, 'settings'),
      present: (id) => exists('user_memory', id),
    },
    {
      path: 'Deleting every memory (DELETE /api/memory)',
      outcome: 'refused',
      seed: (user) => memory(user),
      act: async (user) => (await services()).memory.deleteAllMemories(user),
      present: (id) => exists('user_memory', id),
    },
    {
      path: 'The forget tool, and undoing a saved memory',
      outcome: 'refused',
      seed: (user) => memory(user),
      act: async (user, id) =>
        (await services()).memory.forgetMemory(user, id.slice(0, 8), {
          threadId: randomUUID(),
          messageId: randomUUID(),
        }),
      present: (id) => exists('user_memory', id),
    },
    {
      path: 'Memory retention (retention.memories)',
      outcome: 'skipped',
      seed: (user) => memory(user, old()),
      act: async () => (await services()).memory.applyMemoryRetention(),
      present: (id) => exists('user_memory', id),
    },
    {
      path: 'Audit retention: deletion events about their data (retention.audit-log)',
      outcome: 'skipped',
      seed: (user) => auditEntry(user),
      act: async () => (await services()).retention.pruneAuditLog(),
      present: (id) => exists('audit_log', id),
    },
    {
      path: 'Deleting the account (DELETE /api/admin/users/:id)',
      outcome: 'refused',
      seed: async (user) => user,
      act: async (user) =>
        (await services()).users.deleteUser({ id: admin, email: 'a@x.test' }, user),
      present: (id) => exists('user', id),
    },
  ];

  it.each(PATHS)('$path: $outcome under hold', async (entry) => {
    const heldData = await entry.seed(held);
    const freeData = await entry.seed(free);

    if (entry.outcome === 'refused') {
      await expect(entry.act(held, heldData)).rejects.toMatchObject({ status: 409 });
    } else {
      await entry.act(held, heldData);
    }
    expect(await entry.present(heldData)).toBe(true);

    // The same call for someone not on hold does delete: the check is the hold.
    await entry.act(free, freeData);
    expect(await entry.present(freeData)).toBe(false);
  });

  it('still moves conversations and chat files to the trash, and their purge waits for the hold', async () => {
    const { trash, attachments } = await services();
    const chat = await thread(held);
    const file = await attachment(held, { messageId: await message(chat, held) });
    const other = await thread(held);
    const otherFile = await attachment(held, { messageId: await message(other, held) });
    await attachments.deleteAttachment(otherFile, held);
    await trash.softDeleteThread(chat, held);
    const [row] = await pool.db.execute<{ deleted_at: string | null }>(
      sql`select deleted_at from thread where id = ${chat}`,
    );
    expect(row?.deleted_at).not.toBeNull();
    // Long past the trash window, and still there.
    await pool.db.execute(
      sql`update thread set deleted_at = ${old().toISOString()}::timestamptz where id = ${chat}`,
    );
    await pool.db.execute(
      sql`update attachment set deleted_at = ${old().toISOString()}::timestamptz where id = ${otherFile}`,
    );
    await trash.purgeExpiredTrash();
    expect(await exists('thread', chat)).toBe(true);
    expect(await exists('attachment', file)).toBe(true);
    expect(await exists('attachment', otherFile)).toBe(true);

    // Lifted: the next purge removes them.
    await pool.db.execute(sql`update legal_hold set lifted_at = now() where user_id = ${held}`);
    await trash.purgeExpiredTrash();
    expect(await exists('thread', chat)).toBe(false);
    expect(await exists('attachment', otherFile)).toBe(false);
  });

  it('refuses account deletion in the database on any path', async () => {
    await expect(pool.db.execute(sql`delete from "user" where id = ${held}`)).rejects.toThrow();
    expect(await exists('user', held)).toBe(true);
  });
});

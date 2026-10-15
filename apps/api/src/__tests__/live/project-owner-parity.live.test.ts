import { randomUUID } from 'node:crypto';
import { createDatabase, schema, sql } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  referenceContextFileIds,
  referenceListProjects,
  referenceOwnedAttachmentId,
  referenceProjectFileIds,
  referenceProjectSummary,
  referenceScopedChunkKeys,
  referenceSidebar,
} from '../reference/owner-only-v0.13.1.js';

/**
 * Owner-only behaviour is unchanged for people with no shares (v0.14, project
 * sharing). The v0.13.1 queries are kept as reference code
 * (`__tests__/reference/owner-only-v0.13.1.ts`) and compared, answer for
 * answer, with the access-aware functions that replaced them, over generated
 * data: several people who each own projects with files and conversations, and
 * every other person as an outsider, with no share and no group anywhere. A
 * difference is an owner-only regression; an extra answer for an outsider is a
 * leak.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'features' ? { attachments: true, temporaryChat: true } : {},
  invalidateSettingsCache: () => {},
}));

const projects = await import('../../services/projects.js');
const attachments = await import('../../services/attachments/index.js');
const context = await import('../../services/chat/attachment-context.js');
const retrieval = await import('../../services/project-search/retrieval.js');
const { indexProjectFile } = await import('../../services/project-search/indexing.js');

/** A small deterministic generator, so a failure names the same data every time. */
function rng(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

describe.skipIf(!available)('live: owner-only parity with v0.13.1 (no shares)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  const people: string[] = [];
  const projectRows: Array<{ id: string; owner: string }> = [];
  const fileRows: Array<{ id: string; owner: string; project: string | null }> = [];

  beforeAll(async () => {
    live = await createLiveDatabase('project_owner_parity');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.organizationId = await seedOrganization(pool.db);
    for (let i = 0; i < 4; i += 1) people.push(await seedUser(pool.db, state.organizationId));
    const next = rng(20260414);
    for (const [personIndex, owner] of people.entries()) {
      for (let p = 0; p < 2 + (personIndex % 2); p += 1) {
        const [project] = await pool.db
          .insert(schema.project)
          .values({
            organizationId: state.organizationId,
            userId: owner,
            name: `${personIndex === 1 ? 'b' : 'P'}roject ${personIndex}-${p}`,
            instructions: `Instructions ${personIndex}-${p}`,
          })
          .returning();
        projectRows.push({ id: project!.id, owner });
        // Files: some ready and indexed, one pending, one trashed.
        const count = 1 + Math.floor(next() * 4);
        for (let f = 0; f < count + 2; f += 1) {
          const text = `Notes ${personIndex}-${p}-${f}. ${'The quick brown fox jumps over the lazy dog. '.repeat(40)}`;
          const [file] = await pool.db
            .insert(schema.attachment)
            .values({
              organizationId: state.organizationId,
              userId: owner,
              projectId: project!.id,
              filename: `f${f}.txt`,
              mimeType: 'text/plain',
              sizeBytes: text.length,
              storageKey: randomUUID(),
              extractedText: text,
              uploadPending: f === count,
              deletedAt: f === count + 1 ? new Date() : null,
            })
            .returning();
          fileRows.push({ id: file!.id, owner, project: project!.id });
          if (f < count) await indexProjectFile(file!.id);
        }
        // Conversations: plain, pinned, archived, temporary.
        for (const [title, extra] of [
          ['plain', {}],
          ['pinned', { pinned: true }],
          ['archived', { archived: true }],
          ['plain two', {}],
        ] as const) {
          await pool.db.insert(schema.thread).values({
            organizationId: state.organizationId,
            userId: owner,
            projectId: project!.id,
            title,
            ...extra,
          });
        }
      }
      // A message file (not a project file) and an unsent upload for the person.
      const [thread] = await pool.db
        .insert(schema.thread)
        .values({ organizationId: state.organizationId, userId: owner, title: 'with a file' })
        .returning();
      const [message] = await pool.db
        .insert(schema.message)
        .values({ threadId: thread!.id, userId: owner, role: 'user', parts: [], position: 0 })
        .returning();
      for (const messageId of [message!.id, null]) {
        const [file] = await pool.db
          .insert(schema.attachment)
          .values({
            organizationId: state.organizationId,
            userId: owner,
            messageId,
            filename: 'chat.txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            storageKey: randomUUID(),
            extractedText: 'chat',
          })
          .returning();
        fileRows.push({ id: file!.id, owner, project: null });
      }
    }
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  const strip = <T extends Record<string, unknown>>(value: T) => {
    const { access: _a, ownerName: _o, ...rest } = value;
    return rest;
  };

  it('lists and summarises exactly what v0.13.1 did, for owners, and nothing for outsiders', async () => {
    let compared = 0;
    for (const person of people) {
      const reference = await referenceListProjects(pool.db, person);
      const now = await projects.listProjects(person);
      expect(now.map((row) => strip(row))).toEqual(
        reference.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      );
      expect(await projects.listSharedProjects(person)).toEqual([]);
      expect(await projects.listSharedSidebarProjects(person)).toEqual([]);
      for (const project of projectRows) {
        const expected = await referenceProjectSummary(pool.db, project.id, person);
        if (expected) {
          const summary = await projects.getProjectSummary(project.id, person);
          expect(strip(summary)).toEqual({
            ...expected,
            createdAt: expected.createdAt.toISOString(),
            updatedAt: expected.updatedAt.toISOString(),
          });
          expect(summary.access).toBe('owner');
          expect(summary.ownerName).toBeUndefined();
        } else {
          await expect(projects.getProjectSummary(project.id, person)).rejects.toMatchObject({
            status: 404,
            message: 'Project not found',
          });
        }
        compared += 1;
      }
    }
    expect(compared).toBe(people.length * projectRows.length);
  });

  it('builds the sidebar as v0.13.1 did: the same projects, counts and recent conversations', async () => {
    for (const person of people) {
      const reference = await referenceSidebar(pool.db, person);
      const now = await projects.listSidebarProjects(person);
      expect(
        now.map((row) => ({
          id: row.id,
          name: row.name,
          threadCount: row.threadCount,
          recentThreadIds: row.recentThreads.map((thread) => thread.id),
        })),
      ).toEqual(reference);
      expect(now.every((row) => row.access === 'owner' && row.ownerName === undefined)).toBe(true);
    }
  });

  it('lists a project’s files and the context candidates as v0.13.1 did, and refuses outsiders', async () => {
    for (const person of people) {
      for (const project of projectRows) {
        const expected = await referenceProjectFileIds(pool.db, project.id, person);
        if (expected === null) {
          await expect(projects.listProjectFiles(project.id, person)).rejects.toMatchObject({
            status: 404,
          });
          // The context path: an outsider has no candidates.
          expect(await context.inspectProjectFiles(project.id, person)).toEqual([]);
          expect(await referenceContextFileIds(pool.db, project.id, person)).toEqual([]);
        } else {
          expect(
            (await projects.listProjectFiles(project.id, person)).map((file) => file.id),
          ).toEqual(expected);
          expect(
            (await context.inspectProjectFiles(project.id, person)).map((file) => file.id),
          ).toEqual(await referenceContextFileIds(pool.db, project.id, person));
        }
      }
    }
  });

  it('admits the same passages as v0.13.1 for every person, project and file selection', async () => {
    let nonEmpty = 0;
    for (const person of people) {
      for (const project of projectRows) {
        const ids = fileRows.filter((file) => file.project === project.id).map((file) => file.id);
        for (const fileIds of [
          ids,
          ids.slice(0, 1),
          [...ids, ...fileRows.map((file) => file.id).slice(0, 3)],
        ]) {
          const scope = { userId: person, projectId: project.id, fileIds };
          const expected = await referenceScopedChunkKeys(pool.db, scope);
          const rows = await pool.db.execute<{ attachment_id: string; ordinal: number }>(sql`
            select s.attachment_id, s.ordinal from (${retrieval.scopedChunks(scope)}) s
            order by s.attachment_id, s.ordinal`);
          expect(rows.map((row) => `${row.attachment_id}:${row.ordinal}`)).toEqual(expected);
          if (expected.length > 0) nonEmpty += 1;
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('serves the same files as v0.13.1: own message files and project files, nobody else’s', async () => {
    let served = 0;
    for (const person of people) {
      for (const file of fileRows) {
        const expected = await referenceOwnedAttachmentId(pool.db, file.id, person);
        let actual: string | null = null;
        try {
          actual = (await attachments.getReadableAttachment(file.id, person, 'user')).id;
        } catch (error) {
          expect(error).toMatchObject({ status: 404 });
        }
        // The one deliberate difference: a PROJECT file that is deleted (trashed) is no longer served.
        const trashed = fileRows.indexOf(file) >= 0 && (await isTrashed(file.id));
        expect(actual, `${person} ${file.id}`).toBe(trashed && file.project ? null : expected);
        if (actual) served += 1;
      }
    }
    expect(served).toBeGreaterThan(0);
  });

  async function isTrashed(id: string) {
    const [row] = await pool.db.execute<{ trashed: boolean }>(
      sql`select deleted_at is not null as trashed from attachment where id = ${id}`,
    );
    return row?.trashed === true;
  }
});

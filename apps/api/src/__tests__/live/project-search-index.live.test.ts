import { randomUUID } from 'node:crypto';
import { createDatabase, eq, schema, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Chunking project files into the search index (migration 0026) against real
 * PostgreSQL: the stored 'simple' vectors and GIN index, the claim row that
 * makes indexing idempotent under concurrency, the bounded and restart-safe
 * background job, and the cascades that remove chunks with their file.
 */
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const available = await livePostgresAvailable();

const { indexPendingProjectFiles, indexProjectFile, indexUploadedProjectFile } = await import(
  '../../services/project-search/indexing.js'
);
const { deleteProject, deleteProjectFile, listProjectFiles } = await import(
  '../../services/projects.js'
);
const { MAX_CHUNKS_PER_FILE } = await import('../../services/project-search/chunking.js');

function paragraphs(count: number, word: string): string {
  return Array.from(
    { length: count },
    (_, index) =>
      `${word} paragraph ${index} has enough ordinary words to fill a sizeable part of a chunk, and then some more words so that it reaches a useful length for testing.`,
  ).join('\n\n');
}

describe.skipIf(!available)('live: project file search index', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;
  let owner: string;

  beforeAll(async () => {
    live = await createLiveDatabase('project_search_index');
    pool = createDatabase(live.connectionString, { max: 8 });
    state.db = pool.db;
    organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, organizationId);
  });
  beforeEach(async () => {
    // Each test sees only its own files in the job's queue.
    await pool.db.execute(sql`delete from attachment where project_id is not null`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function project(userId = owner) {
    const [row] = await pool.db
      .insert(schema.project)
      .values({ organizationId, userId, name: `Project ${randomUUID().slice(0, 6)}` })
      .returning();
    return row!;
  }
  async function file(
    projectId: string | null,
    text: string | null,
    extra: Partial<typeof schema.attachment.$inferInsert> = {},
  ) {
    const [row] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId,
        userId: owner,
        projectId,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text ?? ''),
        storageKey: randomUUID(),
        extractedText: text,
        ...extra,
      })
      .returning();
    return row!;
  }
  async function chunks(attachmentId: string) {
    return pool.db
      .select()
      .from(schema.projectFileChunk)
      .where(eq(schema.projectFileChunk.attachmentId, attachmentId))
      .orderBy(schema.projectFileChunk.ordinal);
  }
  async function indexRow(attachmentId: string) {
    const [row] = await pool.db
      .select()
      .from(schema.projectFileIndex)
      .where(eq(schema.projectFileIndex.attachmentId, attachmentId));
    return row;
  }

  it('stores overlapping chunks with offsets and a searchable simple-config vector', async () => {
    const text = paragraphs(20, 'Heron');
    const added = await file((await project()).id, text);
    expect(await indexProjectFile(added.id)).toBe(true);

    const stored = await chunks(added.id);
    expect(stored.length).toBeGreaterThan(2);
    expect(await indexRow(added.id)).toMatchObject({
      chunkCount: stored.length,
      truncated: false,
    });
    for (const [index, chunk] of stored.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
      if (index > 0) expect(chunk.startOffset).toBeLessThan(stored[index - 1]!.endOffset);
    }
    // 'simple' lowercases without stemming: "paragraph" is not reduced to "paragraph".
    const [match] = await pool.db.execute<{ hits: number }>(sql`
      select count(*)::int as hits from project_file_chunk
      where attachment_id = ${added.id}
        and search @@ to_tsquery('simple', 'heron & paragraph')
    `);
    expect(match?.hits).toBe(stored.length);
    const [index] = await pool.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where indexname = 'project_file_chunk_search_idx'
    `);
    expect(index?.indexdef).toContain('USING gin (search)');
  });

  it('is idempotent and indexes each file once under concurrency', async () => {
    const target = await project();
    const files = await Promise.all(
      Array.from({ length: 6 }, (_, index) => file(target.id, paragraphs(8, `Word${index}`))),
    );
    const results = await Promise.all([
      indexPendingProjectFiles(),
      indexPendingProjectFiles(),
      ...files.map((entry) => indexProjectFile(entry.id)),
    ]);
    const total =
      (results[0] as number) +
      (results[1] as number) +
      results.slice(2).filter((value) => value === true).length;
    expect(total).toBe(files.length);
    for (const entry of files) {
      const stored = await chunks(entry.id);
      expect((await indexRow(entry.id))?.chunkCount).toBe(stored.length);
      expect(new Set(stored.map((chunk) => chunk.ordinal)).size).toBe(stored.length);
    }
    expect(await indexPendingProjectFiles()).toBe(0);
    expect(await indexProjectFile(files[0]!.id)).toBe(false);
  });

  it('bounds each run and continues on the next', async () => {
    const target = await project();
    for (let index = 0; index < 5; index += 1) await file(target.id, `File ${index} text.`);
    expect(await indexPendingProjectFiles(2)).toBe(2);
    expect(await indexPendingProjectFiles(2)).toBe(2);
    expect(await indexPendingProjectFiles(2)).toBe(1);
    expect(await indexPendingProjectFiles(2)).toBe(0);
  });

  it('leaves nothing behind when indexing fails part-way, and redoes it on the next run', async () => {
    const target = await project();
    const good = await file(target.id, paragraphs(4, 'Fine'));
    const bad = await file(target.id, `${paragraphs(6, 'Okay')}\n\nPOISON in a later chunk.`);
    // Simulates a crash after some chunks were written: the last insert fails.
    await pool.db.execute(sql`
      alter table project_file_chunk add constraint test_poison check (content not like '%POISON%')
    `);
    try {
      expect(await indexPendingProjectFiles()).toBe(1);
      await expect(indexProjectFile(bad.id)).rejects.toThrow();
      // After an upload the failure is logged, never raised: the upload stands.
      await expect(indexUploadedProjectFile(bad.id)).resolves.toBeUndefined();
      expect(await indexRow(bad.id)).toBeUndefined();
      expect(await chunks(bad.id)).toEqual([]);
      expect((await chunks(good.id)).length).toBeGreaterThan(0);
    } finally {
      await pool.db.execute(sql`alter table project_file_chunk drop constraint test_poison`);
    }
    expect(await indexPendingProjectFiles()).toBe(1);
    expect((await chunks(bad.id)).at(-1)?.content).toContain('POISON');
    expect(await indexPendingProjectFiles()).toBe(0);
  });

  it('records files with no text once and skips anything that is not a ready project file', async () => {
    const target = await project();
    const image = await file(target.id, null, { filename: 'photo.png', mimeType: 'image/png' });
    const blank = await file(target.id, '   \n  ');
    const pending = await file(target.id, 'Still uploading', { uploadPending: true });
    const trashed = await file(target.id, 'Gone', { deletedAt: new Date() });
    const loose = await file(null, 'A chat upload');

    expect(await indexPendingProjectFiles()).toBe(2);
    expect(await indexRow(image.id)).toMatchObject({ chunkCount: 0 });
    expect(await indexRow(blank.id)).toMatchObject({ chunkCount: 0 });
    for (const skipped of [pending, trashed, loose]) {
      expect(await indexProjectFile(skipped.id)).toBe(false);
      expect(await indexRow(skipped.id)).toBeUndefined();
    }
    expect(await indexPendingProjectFiles()).toBe(0);
  });

  it('caps the chunks of one file', async () => {
    const target = await project();
    // About 2.5 million characters: well over the cap at roughly 1,000 per chunk.
    const huge = await file(target.id, paragraphs(15_000, 'Long'));
    expect(await indexProjectFile(huge.id)).toBe(true);
    expect(await indexRow(huge.id)).toMatchObject({
      chunkCount: MAX_CHUNKS_PER_FILE,
      truncated: true,
    });
    const [counted] = await pool.db.execute<{ total: number }>(sql`
      select count(*)::int as total from project_file_chunk where attachment_id = ${huge.id}
    `);
    expect(counted?.total).toBe(MAX_CHUNKS_PER_FILE);
  });

  it('shows each file’s index status on the project’s file list', async () => {
    const target = await project();
    const indexed = await file(target.id, paragraphs(5, 'Listed'));
    const image = await file(target.id, null, { filename: 'photo.png', mimeType: 'image/png' });
    const waiting = await file(target.id, 'Not yet');
    await indexProjectFile(indexed.id);
    await indexProjectFile(image.id);

    const listed = await listProjectFiles(target.id, owner);
    const byId = new Map(listed.map((entry) => [entry.id, entry.index]));
    expect(byId.get(indexed.id)).toEqual({
      status: 'indexed',
      passages: (await chunks(indexed.id)).length,
    });
    expect(byId.get(image.id)).toEqual({ status: 'no-text', passages: 0 });
    expect(byId.get(waiting.id)).toEqual({ status: 'pending', passages: 0 });
  });

  it('removes chunks with the file, with the project and with the account', async () => {
    const first = await project();
    const removed = await file(first.id, paragraphs(5, 'Removed'));
    const kept = await file(first.id, paragraphs(5, 'Kept'));
    await indexPendingProjectFiles();
    expect((await chunks(removed.id)).length).toBeGreaterThan(0);

    await deleteProjectFile(first.id, removed.id, owner);
    expect(await chunks(removed.id)).toEqual([]);
    expect(await indexRow(removed.id)).toBeUndefined();
    expect((await chunks(kept.id)).length).toBeGreaterThan(0);

    await deleteProject(first.id, owner);
    expect(await chunks(kept.id)).toEqual([]);
    expect(await indexRow(kept.id)).toBeUndefined();

    const leaving = await seedUser(pool.db, organizationId);
    const theirs = await project(leaving);
    const [theirFile] = await pool.db
      .insert(schema.attachment)
      .values({
        organizationId,
        userId: leaving,
        projectId: theirs.id,
        filename: 'theirs.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        storageKey: randomUUID(),
        extractedText: paragraphs(3, 'Theirs'),
      })
      .returning();
    await indexProjectFile(theirFile!.id);
    expect((await chunks(theirFile!.id)).length).toBeGreaterThan(0);
    await pool.db.delete(schema.user).where(eq(schema.user.id, leaving));
    expect(await chunks(theirFile!.id)).toEqual([]);
  });
});

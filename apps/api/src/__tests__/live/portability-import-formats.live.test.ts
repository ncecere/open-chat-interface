import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '@oci/db';
import { strToU8, zipSync } from 'fflate';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { livePostgresAvailable } from '../../../test/live-postgres.js';
import {
  chatgptSimple,
  chatgptZip,
  claudeV1,
  claudeV2,
  type PortabilityImportContext,
  usePortabilityImportSuite,
} from '../../../test/portability-import.fixtures.js';

/**
 * ChatGPT and Claude imports through the real upload route, job processing,
 * PostgreSQL and local storage. Fixtures are small synthetic exports
 * (test/portability-import.fixtures.ts), shaped after the documented quirks.
 * Reading exports: ChatGPT and Claude formats, idempotence, nested archives,
 * and archives that are unsafe or not exports at all.
 */
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  runJobNow: null as unknown as ReturnType<typeof vi.fn<(name: string) => Promise<number>>>,
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../services/limits/rate-limit.js', () => ({
  consumeRateLimit: async () => ({ allowed: true, limit: 10, remaining: 9, retryAfterSeconds: 1 }),
}));
vi.mock('../../services/jobs/index.js', () => ({
  runJobNow: (name: string) => state.runJobNow(name),
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) =>
    key === 'storage'
      ? {
          driver: 'local',
          maxFileBytes: 10 * 1024 * 1024,
          maxFilesPerMessage: 10,
          allowedMimeTypes: ['text/plain'],
          s3: {
            bucket: '',
            region: 'us-east-1',
            endpoint: null,
            accessKeyId: '',
            encryptedSecretAccessKey: null,
            forcePathStyle: false,
          },
        }
      : {},
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      STORAGE_LOCAL_PATH: storageRoot,
      IMPORT_MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
    }),
  };
});

const available = await livePostgresAvailable();
const storageRoot = mkdtempSync(join(tmpdir(), 'oci-import-'));
const { processPendingImports } = await import('../../services/portability/imports.js');
const { DEFAULT_READER_LIMITS } = await import('../../services/portability/import-reader.js');

describe.skipIf(!available)('live Postgres: ChatGPT and Claude import', () => {
  const suite = usePortabilityImportSuite(state, storageRoot);
  const { upload, importsFor, threadsFor, messagesOf } = suite;
  let live: PortabilityImportContext['live'];
  let userId: PortabilityImportContext['userId'];
  beforeAll(() => {
    ({ live, userId } = suite.ctx);
  });

  it('queues an upload, then imports the visible ChatGPT path on processing', async () => {
    const response = await upload(userId, chatgptZip({ missingListed: true }));
    expect(response.status).toBe(202);
    const { import: queued } = (await response.json()) as { import: Record<string, unknown> };
    expect(queued).toMatchObject({ status: 'pending', filename: 'export.zip' });
    expect(state.runJobNow).toHaveBeenCalledWith('imports.process');

    const [stored] = await live.db.execute<{ storage_key: string }>(
      sql`select storage_key from conversation_import where id = ${queued.id as string}`,
    );
    expect(existsSync(join(storageRoot, stored?.storage_key as string))).toBe(true);

    expect(await processPendingImports()).toBe(1);

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({
      status: 'completed',
      source: 'chatgpt',
      formatVersion: 'v2',
      importedCount: 2,
      skippedCount: 0,
      failedCount: 0,
      error: null,
    });
    expect(record?.unknownContentTypes).toEqual({ 'chatgpt.hologram': 1 });
    expect(String(record?.warnings)).toMatch(/incomplete/);

    // The upload is released once processed.
    expect(existsSync(join(storageRoot, stored?.storage_key as string))).toBe(false);
    const [released] = await live.db.execute<{ storage_key: string | null }>(
      sql`select storage_key from conversation_import where id = ${queued.id as string}`,
    );
    expect(released?.storage_key).toBeNull();

    const threads = await threadsFor(userId);
    expect(
      threads.map((thread) => [thread.title, thread.import_source, thread.import_source_id]),
    ).toEqual([
      ['Planning a garden', 'chatgpt', 'gpt-branching'],
      ['Imported conversation', 'chatgpt', 'gpt-simple'],
    ]);
    const garden = threads[0] as (typeof threads)[number];
    expect(new Date(garden.created_at).toISOString()).toBe('2025-01-07T00:23:20.120Z');
    expect(new Date(garden.updated_at).toISOString()).toBe('2025-01-07T00:30:00.500Z');
    expect(garden.last_message_at).not.toBeNull();

    const messages = await messagesOf(garden.id);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
    expect(messages.every((message) => message.status === 'complete')).toBe(true);
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'What should I plant?' }]);
    expect(new Date(messages[0]?.created_at as Date).toISOString()).toBe(
      '2025-01-07T00:23:30.000Z',
    );
    expect(messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'Weighing the climate' },
      { type: 'text', text: 'Plant tomatoes.' },
    ]);
    expect(messages[1]?.model_slug).toBe('gpt-4o');
    expect(messages[1]?.parent_message_id).toBe(messages[0]?.id);
    expect(messages[2]?.parts).toEqual([
      { type: 'text', text: '_Attached in ChatGPT: bed.png (file not imported)_' },
      { type: 'text', text: 'What about this bed?' },
    ]);
    // The null-parts placeholder and the split reply collapse into one answer.
    expect(messages[3]?.parts).toEqual([{ type: 'text', text: 'It gets full sun.' }]);
    expect(messages[3]?.parent_message_id).toBe(messages[2]?.id);

    const everything = JSON.stringify(messages);
    for (const hidden of [
      'Regenerated-away answer',
      'You are ChatGPT',
      'Hidden instruction',
      'internal',
      'secret',
    ]) {
      expect(everything).not.toContain(hidden);
    }

    // Imported history is not generated usage.
    const [usage] = await live.db.execute<{ count: number }>(
      sql`select count(*)::int as count from usage_event where user_id = ${userId}`,
    );
    expect(usage?.count).toBe(0);

    const audits = await live.db.execute<{ metadata: { stage: string } }>(sql`
      select metadata from audit_log where action = 'user.import' and actor_user_id = ${userId}
      order by created_at
    `);
    expect(audits.map((row) => row.metadata.stage)).toEqual(['queued', 'completed']);
  });

  it('is idempotent: importing the same export again skips what is already there', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports();
    const [garden] = await threadsFor(userId);
    await live.db.execute(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${garden?.id as string}, ${userId}, 'user', '[{"type":"text","text":"Added here"}]'::jsonb, 4)
    `);

    expect((await upload(userId, chatgptZip())).status).toBe(202);
    await processPendingImports();

    const [latest] = await importsFor(userId);
    expect(latest).toMatchObject({ status: 'completed', importedCount: 0, skippedCount: 2 });
    expect(await threadsFor(userId)).toHaveLength(2);
    // Messages added after the first import are untouched.
    expect((await messagesOf(garden?.id as string)).at(-1)?.parts).toEqual([
      { type: 'text', text: 'Added here' },
    ]);
  });

  it('imports Claude text-only (v1) and content-block (v2) conversations from a bare JSON file', async () => {
    const response = await upload(
      userId,
      `\uFEFF${JSON.stringify([claudeV1, claudeV2])}\n`,
      'conversations.json',
    );
    expect(response.status).toBe(202);
    await processPendingImports();

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({
      status: 'completed',
      source: 'claude',
      formatVersion: 'v2',
      importedCount: 2,
    });
    expect(record?.unknownContentTypes).toEqual({ 'claude.sparkle_block': 1 });

    const threads = await threadsFor(userId);
    expect(threads.map((thread) => thread.title)).toEqual([
      'Recipe ideas',
      'Imported conversation',
    ]);
    const v1 = threads[0] as (typeof threads)[number];
    expect(new Date(v1.created_at).toISOString()).toBe('2026-02-14T10:04:22.000Z');
    expect((await messagesOf(v1.id)).map((message) => message.parts)).toEqual([
      [
        { type: 'text', text: '_Attached in Claude: pantry.pdf (file not imported)_' },
        { type: 'text', text: 'Suggest a soup' },
      ],
      [{ type: 'text', text: 'Try minestrone.' }],
    ]);

    const v2Messages = await messagesOf((threads[1] as (typeof threads)[number]).id);
    expect(v2Messages.map((message) => message.parts)).toEqual([
      [{ type: 'text', text: 'Explain tides' }],
      [
        { type: 'reasoning', text: 'Gravity, mostly' },
        { type: 'text', text: 'The moon pulls the sea.' },
      ],
      [
        { type: 'text', text: '_Attached in Claude: chart.png (file not imported)_' },
        { type: 'text', text: 'Thanks' },
      ],
      [{ type: 'text', text: 'You are welcome.' }],
    ]);
    expect(v2Messages[1]?.model_slug).toBe('claude-sonnet-4-5');
    expect(JSON.stringify(v2Messages)).not.toContain('Abandoned branch');
  });

  it('reads a Privacy Portal export that nests the conversations archive', async () => {
    const inner = zipSync({ 'conversations.json': strToU8(JSON.stringify([chatgptSimple])) });
    const outer = Buffer.from(
      zipSync({
        'User Online Activity/Conversations__2026-chatgpt-1.zip': inner,
        'User Online Activity/Ads__2026.zip': zipSync({ 'ads.json': strToU8('[]') }),
      }),
    );
    await upload(userId, outer);
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'completed', source: 'chatgpt', importedCount: 1 });
  });

  it('rejects a zip bomb by its actual decompressed output', async () => {
    const bomb = Buffer.from(
      zipSync({ 'conversations.json': strToU8(`[${' '.repeat(4 * 1024 * 1024)}]`) }, { level: 9 }),
    );
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await upload(userId, bomb);
    await processPendingImports({
      limits: { ...DEFAULT_READER_LIMITS, ratioGraceBytes: 1024 * 1024 },
    });

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed', importedCount: 0 });
    expect(record?.error).toMatch(/compressed suspiciously/);
  });

  it('caps total decompressed size', async () => {
    await upload(userId, chatgptZip());
    await processPendingImports({
      limits: { ...DEFAULT_READER_LIMITS, maxUncompressedBytes: 1024 },
    });
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/expands to more data/);
  });

  it('rejects archives with path traversal entries', async () => {
    const evil = Buffer.from(
      zipSync({
        '../../outside.json': strToU8('[]'),
        'conversations.json': strToU8(JSON.stringify([chatgptSimple])),
      }),
    );
    await upload(userId, evil);
    await processPendingImports();

    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed', importedCount: 0 });
    expect(record?.error).toMatch(/unsafe file path/);
    expect(existsSync(join(storageRoot, '..', 'outside.json'))).toBe(false);
    expect(await threadsFor(userId)).toHaveLength(0);
  });

  it('fails clearly on a file that is not an export', async () => {
    await upload(userId, 'just some notes', 'notes.txt');
    await processPendingImports();
    const [record] = await importsFor(userId);
    expect(record).toMatchObject({ status: 'failed' });
    expect(record?.error).toMatch(/Upload the \.zip file/);
  });
});

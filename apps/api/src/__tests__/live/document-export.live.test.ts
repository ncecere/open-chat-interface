import { sql } from '@oci/db';
import { DOCUMENT_FORMAT_INFO, MAX_DOCUMENT_EXPORT_INPUT_BYTES } from '@oci/shared';
import ExcelJS from 'exceljs';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import { xmlTexts } from '../../../test/xml.js';

/**
 * File output (v0.9) through the real thread and artifact routes, PostgreSQL,
 * the shared download allowance and the generation worker: ownership, the
 * active path, versions, refusals, limits and the audit record.
 */
const available = await livePostgresAvailable();

const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async () => ({ branching: true, shareLinks: true, temporaryChat: true }),
}));
// Counted in-process, so each run starts from zero.
vi.mock('../../services/chat-streams.js', () => ({ sharedRedis: async () => null }));

import type { AppBindings } from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { artifactRoutes } from '../../routes/artifacts.js';
import { threadRoutes } from '../../routes/threads.js';
import { FILE_EXPORTS_PER_HOUR } from '../../services/documents/export.js';

const REPLY = [
  '# Findings',
  '',
  'Revenue grew <script>alert("x")</script> & more.',
  '',
  '- first point',
  '  - nested point',
  '',
  '| Region | Revenue |',
  '| --- | ---: |',
  '| North | 1,200 |',
  '| South | 800 |',
].join('\n');

describe.skipIf(!available)('live Postgres: document export', () => {
  let live: LiveDatabase;
  let ownerId: string;
  let strangerId: string;
  let thirdId: string;
  let threadId: string;
  let trashedThreadId: string;
  const ids: Record<string, string> = {};

  function appFor(userId: string) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        email: `${userId}@example.com`,
        name: 'User',
        image: null,
        role: 'user',
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/threads', threadRoutes);
    app.route('/api/artifacts', artifactRoutes);
    return app;
  }

  const replyUrl = (messageId: string, format: string, thread = threadId) =>
    `/api/threads/${thread}/messages/${messageId}/export?format=${format}`;
  const artifactUrl = (artifactId: string, format: string, version?: number) =>
    `/api/artifacts/${artifactId}/export?format=${format}${version !== undefined ? `&version=${version}` : ''}`;
  const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());
  const errorMessage = async (response: Response) =>
    ((await response.json()) as { error: { message: string } }).error.message;
  const docxText = async (response: Response) =>
    xmlTexts(strFromU8(unzipSync(await bytesOf(response))['word/document.xml']!), 'w:t').join('\n');

  async function message(
    thread: string,
    role: 'user' | 'assistant',
    text: string,
    position: number,
    extra: { status?: string; superseded?: boolean } = {},
  ): Promise<string> {
    const parts = JSON.stringify(text ? [{ type: 'text', text }] : []);
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position, model_slug, status, superseded_at)
      values (${thread}, ${ownerId}, ${role}, ${parts}::jsonb, ${position},
        ${role === 'assistant' ? 'model-a' : null}, ${extra.status ?? 'complete'},
        ${extra.superseded ? sql`now()` : null})
      returning id
    `);
    return row!.id;
  }

  async function artifact(
    thread: string,
    messageId: string,
    kind: string,
    versions: string[],
  ): Promise<string> {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into artifact (user_id, thread_id, message_id, source_key, title, kind, current_version)
      values (${ownerId}, ${thread}, ${messageId}, ${`tool:${kind}-${versions.length}`},
        ${`Notes: ${kind} "draft"`}, ${kind}, ${versions.length})
      returning id
    `);
    for (const [index, content] of versions.entries())
      await live.db.execute(sql`
        insert into artifact_version (artifact_id, version, content, size_bytes, source, message_id)
        values (${row!.id}, ${index + 1}, ${content}, ${Buffer.byteLength(content)}, 'reply', ${messageId})
      `);
    return row!.id;
  }

  async function newThread(title: string, owner?: string): Promise<string> {
    const [row] = await live.db.execute<{ id: string }>(sql`
      insert into thread (organization_id, user_id, title)
      values (${state.organizationId}, ${owner ?? ownerId}, ${title}) returning id
    `);
    return row!.id;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('document_export');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    ownerId = await seedUser(live.db, state.organizationId, { email: 'owner@example.com' });
    strangerId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });
    thirdId = await seedUser(live.db, state.organizationId, { email: 'third@example.com' });

    threadId = await newThread('Quarterly plan: Q3 & "more"');
    ids.prompt = await message(threadId, 'user', 'Summarise the quarter', 0);
    ids.replaced = await message(threadId, 'assistant', 'OLD REPLY', 1, { superseded: true });
    ids.reply = await message(threadId, 'assistant', REPLY, 2);
    await message(threadId, 'user', 'And in words?', 3);
    ids.plain = await message(threadId, 'assistant', 'Just words, no tables.', 4);
    ids.failed = await message(threadId, 'assistant', '', 5, { status: 'error' });
    ids.streaming = await message(threadId, 'assistant', 'Half a rep', 6, { status: 'streaming' });
    ids.huge = await message(
      threadId,
      'assistant',
      'x'.repeat(MAX_DOCUMENT_EXPORT_INPUT_BYTES + 1),
      7,
    );
    ids.document = await artifact(threadId, ids.reply, 'markdown', [
      'Version one text',
      '## Version two\n\n| a | b |\n| - | - |\n| 1 | 2 |',
    ]);
    ids.page = await artifact(threadId, ids.reply, 'html', ['<!doctype html><p>Hi</p>']);

    trashedThreadId = await newThread('Trashed');
    ids.trashedReply = await message(trashedThreadId, 'assistant', 'In the trash', 0);
    ids.trashedDocument = await artifact(trashedThreadId, ids.trashedReply, 'markdown', ['Gone']);
    await live.db.execute(sql`update thread set deleted_at = now() where id = ${trashedThreadId}`);
  });

  afterAll(async () => {
    await live?.destroy();
  });

  describe('replies', () => {
    it('downloads a reply as DOCX, titled after the conversation', async () => {
      const response = await appFor(ownerId).request(replyUrl(ids.reply!, 'docx'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(DOCUMENT_FORMAT_INFO.docx.mimeType);
      expect(response.headers.get('content-disposition')).toMatch(
        /^attachment; filename="quarterly-plan-q3-more-reply-\d{4}-\d{2}-\d{2}\.docx"; filename\*=UTF-8''quarterly-plan-q3-more-reply-\d{4}-\d{2}-\d{2}\.docx$/,
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const text = await docxText(response);
      expect(text).toContain('Quarterly plan: Q3 & "more"');
      expect(text).toContain('Revenue grew <script>alert("x")</script> & more.');
      expect(text).toContain('nested point');
      expect(text).not.toContain('OLD REPLY');
    });

    it('downloads PDF, PPTX and XLSX', async () => {
      const app = appFor(ownerId);
      const pdf = await app.request(replyUrl(ids.reply!, 'pdf'));
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      const document = await getDocumentProxy(await bytesOf(pdf));
      expect((await extractText(document, { mergePages: true })).text).toContain('first point');

      const pptx = await app.request(replyUrl(ids.reply!, 'pptx'));
      expect(pptx.status).toBe(200);
      expect(pptx.headers.get('content-disposition')).toMatch(
        /\.pptx"; filename\*=UTF-8''[^;]*\.pptx$/,
      );
      const slides = unzipSync(await bytesOf(pptx));
      expect(strFromU8(slides['ppt/slides/slide2.xml']!)).toContain('Findings');

      const xlsx = await app.request(replyUrl(ids.reply!, 'xlsx'));
      expect(xlsx.status).toBe(200);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load((await xlsx.arrayBuffer()) as ArrayBuffer);
      expect(book.worksheets[0]!.getCell('B2').value).toBe(1200);
      expect(book.worksheets[0]!.name).toBe('Findings');
    });

    it('refuses a spreadsheet of a reply without tables, and unknown formats', async () => {
      const app = appFor(ownerId);
      const plain = await app.request(replyUrl(ids.plain!, 'xlsx'));
      expect(plain.status).toBe(422);
      expect(await errorMessage(plain)).toBe('No tables to export');
      expect((await app.request(replyUrl(ids.plain!, 'docx'))).status).toBe(200);
      expect((await app.request(replyUrl(ids.plain!, 'html'))).status).toBe(422);
      expect(
        (await app.request(`/api/threads/${threadId}/messages/${ids.plain}/export`)).status,
      ).toBe(422);
    });

    it('serves only the owner’s replies on the active path of a conversation not in the trash', async () => {
      const owner = appFor(ownerId);
      expect((await appFor(strangerId).request(replyUrl(ids.reply!, 'docx'))).status).toBe(404);
      expect((await owner.request(replyUrl(ids.replaced!, 'docx'))).status).toBe(404);
      expect((await owner.request(replyUrl(ids.prompt!, 'docx'))).status).toBe(404);
      expect((await owner.request(replyUrl('no-such-message', 'docx'))).status).toBe(404);
      // A reply addressed through another conversation is not found.
      const other = await newThread('Other');
      expect((await owner.request(replyUrl(ids.reply!, 'docx', other))).status).toBe(404);
      expect(
        (await owner.request(replyUrl(ids.trashedReply!, 'docx', trashedThreadId))).status,
      ).toBe(404);
    });

    it('refuses replies being written, without text, or too large', async () => {
      const app = appFor(ownerId);
      expect((await app.request(replyUrl(ids.streaming!, 'docx'))).status).toBe(409);
      const failed = await app.request(replyUrl(ids.failed!, 'pdf'));
      expect(failed.status).toBe(422);
      expect(await errorMessage(failed)).toBe('There is no text to export.');
      const huge = await app.request(replyUrl(ids.huge!, 'docx'));
      expect(huge.status).toBe(422);
      expect(await errorMessage(huge)).toContain('512 KB');
    });

    it('audits each download with metadata only', async () => {
      const rows = await live.db.execute<{
        target_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
      }>(sql`
        select target_type, target_id, metadata from audit_log
        where action = 'message.export' and actor_user_id = ${ownerId}
      `);
      // DOCX, PDF, PPTX, XLSX of the reply and DOCX of the plain one: refusals are not recorded.
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.target_type).toBe('message');
        expect(Object.keys(row.metadata).sort()).toEqual(['format', 'sizeBytes', 'threadId']);
        expect(row.metadata.threadId).toBe(threadId);
        expect(JSON.stringify(row.metadata)).not.toMatch(/Quarterly|Revenue|words/);
      }
      const formats = rows
        .filter((row) => row.target_id === ids.reply)
        .map((row) => row.metadata.format);
      expect(formats.sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    });
  });

  describe('artifacts', () => {
    it('downloads the current version, or the one asked for', async () => {
      const app = appFor(ownerId);
      const current = await app.request(artifactUrl(ids.document!, 'docx'));
      expect(current.status).toBe(200);
      expect(current.headers.get('content-disposition')).toBe(
        `attachment; filename="notes-markdown-draft-v2.docx"; filename*=UTF-8''notes-markdown-draft-v2.docx`,
      );
      const text = await docxText(current);
      expect(text).toContain('Notes: markdown "draft"');
      expect(text).toContain('Version two');

      const first = await app.request(artifactUrl(ids.document!, 'docx', 1));
      expect(first.headers.get('content-disposition')).toContain('-v1.docx');
      expect(await docxText(first)).toContain('Version one text');

      expect((await app.request(artifactUrl(ids.document!, 'xlsx'))).status).toBe(200);
      const noTable = await app.request(artifactUrl(ids.document!, 'xlsx', 1));
      expect(noTable.status).toBe(422);
      expect((await app.request(artifactUrl(ids.document!, 'pdf', 9))).status).toBe(404);
      expect((await app.request(artifactUrl(ids.document!, 'pdf', 0))).status).toBe(422);
    });

    it('exports only Markdown documents', async () => {
      const response = await appFor(ownerId).request(artifactUrl(ids.page!, 'pdf'));
      expect(response.status).toBe(422);
      expect(await errorMessage(response)).toContain('Only documents');
    });

    it('serves only the owner’s artifacts outside the trash', async () => {
      const owner = appFor(ownerId);
      expect((await appFor(strangerId).request(artifactUrl(ids.document!, 'docx'))).status).toBe(
        404,
      );
      expect((await owner.request(artifactUrl(ids.trashedDocument!, 'docx'))).status).toBe(404);
      expect((await owner.request(artifactUrl('missing', 'docx'))).status).toBe(404);
    });

    it('audits each download with metadata only', async () => {
      const rows = await live.db.execute<{ target_id: string; metadata: Record<string, unknown> }>(
        sql`select target_id, metadata from audit_log where action = 'artifact.export'`,
      );
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.target_id).toBe(ids.document);
        expect(Object.keys(row.metadata).sort()).toEqual([
          'format',
          'sizeBytes',
          'threadId',
          'version',
        ]);
        expect(JSON.stringify(row.metadata)).not.toMatch(/Version|Notes/);
      }
      expect(rows.map((row) => row.metadata.version).sort()).toEqual([1, 2, 2]);
    });
  });

  it('names downloads after a title in any script (#361)', async () => {
    const app = appFor(ownerId);
    const nameOf = (response: Response) => {
      const header = response.headers.get('content-disposition') ?? '';
      // Every character of the header is ASCII; filename* carries the real name.
      expect([...header].every((character) => character >= ' ' && character <= '~')).toBe(true);
      expect(header).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);
      return decodeURIComponent(header.split("filename*=UTF-8''")[1]!);
    };
    const japanese = await newThread('日本語の宿題');
    const reply = await message(japanese, 'assistant', 'Short reply', 0);
    const docx = await app.request(replyUrl(reply, 'docx', japanese));
    expect(docx.status).toBe(200);
    expect(nameOf(docx)).toMatch(/^日本語の宿題-reply-\d{4}-\d{2}-\d{2}\.docx$/);

    const arabic = await newThread('واجب الكتابة 📚');
    const markdown = await app.request(`/api/threads/${arabic}/export`);
    expect(markdown.status).toBe(200);
    expect(nameOf(markdown)).toMatch(/^واجب-الكتابة-\d{4}-\d{2}-\d{2}\.md$/);

    const russian = await newThread('Домашнее задание');
    const note = await message(russian, 'assistant', 'Text', 0);
    const [titled] = await live.db.execute<{ id: string }>(sql`
      insert into artifact (user_id, thread_id, message_id, source_key, title, kind, current_version)
      values (${ownerId}, ${russian}, ${note}, 'tool:markdown-ru', 'План урока', 'markdown', 1)
      returning id
    `);
    await live.db.execute(sql`
      insert into artifact_version (artifact_id, version, content, size_bytes, source, message_id)
      values (${titled!.id}, 1, 'Текст', ${Buffer.byteLength('Текст')}, 'reply', ${note})
    `);
    const download = await app.request(artifactUrl(titled!.id, 'docx'));
    expect(download.status).toBe(200);
    expect(nameOf(download)).toBe('план-урока-v1.docx');
  });

  it('shares one hourly allowance with conversation downloads', async () => {
    const thread = await newThread('Allowance', thirdId);
    const [reply] = await live.db.execute<{ id: string }>(sql`
      insert into message (thread_id, user_id, role, parts, position)
      values (${thread}, ${thirdId}, 'assistant', '[{"type":"text","text":"Short reply"}]'::jsonb, 0)
      returning id
    `);
    const app = appFor(thirdId);
    for (let index = 0; index < FILE_EXPORTS_PER_HOUR; index++) {
      const markdown = await app.request(`/api/threads/${thread}/export`);
      expect(markdown.status).toBe(200);
    }
    const limited = await app.request(replyUrl(reply!.id, 'docx', thread));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await app.request(`/api/threads/${thread}/export`)).status).toBe(429);
    // Refusals are decided before the allowance is used, so they still explain themselves.
    expect((await app.request(replyUrl(reply!.id, 'xlsx', thread))).status).toBe(422);
    // Other people are unaffected.
    expect((await appFor(ownerId).request(replyUrl(ids.plain!, 'docx'))).status).toBe(200);
  });
});

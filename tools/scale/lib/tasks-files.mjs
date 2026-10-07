import { EmbeddingCopy, TextCopy, text, ts } from './copy.mjs';
import { embedText } from './embed.mjs';
import { FILE_STATE, ids, personAttributes, projectTopics } from './plan.mjs';
import { hashString, Rng } from './prng.mjs';
import { PROJECT_FILE_KINDS, projectCreatedMs } from './tasks-common.mjs';
import { chunkText, documentText, word } from './text.mjs';

// ---------------------------------------------------------------------------
// Project files: attachment, project_file_index, project_file_chunk, embeddings
// ---------------------------------------------------------------------------

export async function filesTask(ctx, from, to) {
  const { sql, seedHash, nowMs, plan, dimensions, modelKey } = ctx;
  const id = ids(seedHash);
  const attachments = await TextCopy.open(sql, 'attachment', [
    'id',
    'organization_id',
    'user_id',
    'project_id',
    'filename',
    'mime_type',
    'size_bytes',
    'storage_key',
    'extracted_text',
    'created_at',
    'updated_at',
  ]);
  const indexes = await TextCopy.open(sql, 'project_file_index', [
    'attachment_id',
    'chunk_count',
    'truncated',
    'indexed_at',
  ]);
  const chunks = await TextCopy.open(sql, 'project_file_chunk', [
    'attachment_id',
    'ordinal',
    'start_offset',
    'end_offset',
    'content',
  ]);
  const embeddings = await EmbeddingCopy.open(sql, ctx.embeddingTable, dimensions);
  const { fileProject, projectOwner, fileChunks, fileState } = plan;

  for (let f = from; f < to; f++) {
    const rng = new Rng(seedHash, hashString('file'), f);
    const p = fileProject[f];
    const ownerIndex = projectOwner[p];
    const owner = personAttributes(seedHash, ownerIndex, nowMs);
    const userId = id.person(ownerIndex);
    const fileId = id.file(f);
    const state = fileState[f];
    const topics = projectTopics(seedHash, p);
    const projectCreated = projectCreatedMs(seedHash, p, owner.joinedMs, nowMs);
    const created = projectCreated + rng.float() * (nowMs - projectCreated);
    const isImage = state === FILE_STATE.noText;
    const kind = isImage ? { ext: 'png', mime: 'image/png' } : rng.pick(PROJECT_FILE_KINDS);
    const extracted = isImage ? null : documentText(rng, topics, fileChunks[f] * 1000 + 150);
    const size = isImage
      ? Math.round(Math.max(20_000, rng.lognormal(13, 0.8)))
      : Math.round(extracted.length * (kind.ext === 'pdf' || kind.ext === 'docx' ? 3.2 : 1.05));
    const filename = `${topics[0]}-${word(rng).replace(/[^a-z]/g, '') || 'notes'}-${rng.int(100)}.${kind.ext}`;
    attachments.row([
      fileId,
      ctx.organizationId,
      userId,
      id.project(p),
      text(filename),
      kind.mime,
      String(size),
      `${userId}/${fileId}.${kind.ext}`,
      text(extracted),
      ts(created),
      ts(created),
    ]);
    if (state !== FILE_STATE.pending) {
      const passages = extracted ? chunkText(extracted) : [];
      indexes.row([fileId, String(passages.length), 'f', ts(created + 5_000)]);
      for (let o = 0; o < passages.length; o++) {
        const passage = passages[o];
        chunks.row([
          fileId,
          String(o),
          String(passage.start),
          String(passage.end),
          text(passage.content),
        ]);
        if (state === FILE_STATE.embedded) {
          embeddings.row(
            fileId,
            o,
            modelKey,
            embedText(passage.content, dimensions),
            created + 30_000,
          );
        }
      }
    }
    await attachments.maybeFlush();
    await chunks.maybeFlush();
    await embeddings.maybeFlush();
  }
  return {
    'attachment (project files)': await attachments.end(),
    project_file_index: await indexes.end(),
    project_file_chunk: await chunks.end(),
    [ctx.embeddingTable]: await embeddings.end(),
  };
}

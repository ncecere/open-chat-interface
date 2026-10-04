/**
 * Row generators, one per slice of the dataset. Each runs inside a worker with
 * its own database connections and writes its tables through COPY. Every
 * value is derived from (seed, index), so a slice is the same whichever worker
 * writes it and in whatever order.
 */
import { bool, EmbeddingCopy, json, TextCopy, text, ts } from './copy.mjs';
import { embedText } from './embed.mjs';
import {
  conversationFlags,
  DAY_MS,
  FILE_STATE,
  ids,
  personAttributes,
  projectTopics,
} from './plan.mjs';
import { hash01, hashString, Rng } from './prng.mjs';
import {
  assistantMarkdown,
  chunkText,
  documentText,
  reasoningText,
  sentence,
  title,
  userText,
  word,
} from './text.mjs';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Messages written before this many days ago predate v0.9's change sequence and keep NULL. */
const CHANGE_SEQ_DAYS = 150;
const CHANGE_SEQ_EPOCH = Date.UTC(2020, 0, 1);
const CONTEXT_WINDOW_TOKENS = 128_000;

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
];

const ATTACHMENT_KINDS = [
  { ext: 'png', mime: 'image/png', weight: 0.5, text: false },
  { ext: 'pdf', mime: 'application/pdf', weight: 0.3, text: true },
  { ext: 'txt', mime: 'text/plain', weight: 0.1, text: true },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    weight: 0.1,
    text: true,
  },
];

const PROJECT_FILE_KINDS = [
  { ext: 'pdf', mime: 'application/pdf' },
  { ext: 'md', mime: 'text/markdown' },
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'docx', mime: ATTACHMENT_KINDS[3].mime },
];

function ip(seedHash, kind, index) {
  const v = Math.floor(hash01(seedHash, kind, index) * 0xffffff);
  return `10.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

function pickWeighted(rng, items) {
  let u = rng.float();
  for (const item of items) {
    u -= item.weight;
    if (u < 0) return item;
  }
  return items[items.length - 1];
}

export function projectCreatedMs(seedHash, p, ownerJoinedMs, nowMs) {
  return ownerJoinedMs + hash01(seedHash, 0x3020, p) * (nowMs - ownerJoinedMs) * 0.7;
}

// ---------------------------------------------------------------------------
// People: user, account, session, user_preference, project
// ---------------------------------------------------------------------------

export async function peopleTask(ctx, from, to) {
  const { sql, seedHash, nowMs, plan } = ctx;
  const id = ids(seedHash);
  const users = await TextCopy.open(sql, 'user', [
    'id',
    'name',
    'email',
    'email_verified',
    'role',
    'banned',
    'ban_reason',
    'organization_id',
    'last_seen_at',
    'created_at',
    'updated_at',
  ]);
  const accounts = await TextCopy.open(sql, 'account', [
    'id',
    'user_id',
    'account_id',
    'provider_id',
    'password',
    'created_at',
    'updated_at',
  ]);
  const sessions = await TextCopy.open(sql, 'session', [
    'id',
    'user_id',
    'token',
    'expires_at',
    'ip_address',
    'user_agent',
    'created_at',
    'updated_at',
  ]);
  const preferences = await TextCopy.open(sql, 'user_preference', [
    'id',
    'user_id',
    'theme',
    'density',
    'onboarded_at',
    'created_at',
    'updated_at',
  ]);
  const projects = await TextCopy.open(sql, 'project', [
    'id',
    'organization_id',
    'user_id',
    'name',
    'instructions',
    'created_at',
    'updated_at',
  ]);
  const { personConvStart, personProjectStart } = plan;

  for (let i = from; i < to; i++) {
    const rng = new Rng(seedHash, hashString('person'), i);
    const person = personAttributes(seedHash, i, nowMs);
    const userId = id.person(i);
    const conversations = personConvStart[i + 1] - personConvStart[i];
    const lastSeen =
      conversations > 0 ? nowMs - Math.min(300, rng.pareto(0.9) - 1) * DAY_MS : person.joinedMs;
    users.row([
      userId,
      text(person.name),
      person.email,
      't',
      person.role,
      bool(person.banned),
      person.banned ? 'Repeated misuse' : '\\N',
      ctx.organizationId,
      ts(Math.max(person.joinedMs, lastSeen)),
      ts(person.joinedMs),
      ts(person.joinedMs),
    ]);
    accounts.row([
      id.account(i),
      userId,
      userId,
      'credential',
      ctx.passwordHash,
      ts(person.joinedMs),
      ts(person.joinedMs),
    ]);
    if (!person.banned && conversations > 0 && rng.chance(0.6)) {
      const created = Math.max(person.joinedMs, nowMs - rng.float() * 25 * DAY_MS);
      sessions.row([
        id.session(i),
        userId,
        rng.token(24),
        ts(created + 30 * DAY_MS),
        ip(seedHash, 0x4001, i),
        text(rng.pick(USER_AGENTS)),
        ts(created),
        ts(created),
      ]);
    }
    if (rng.chance(0.75)) {
      const onboarded = person.joinedMs + rng.range(1, 30) * MINUTE_MS;
      preferences.row([
        id.preference(i),
        userId,
        rng.pick(['dark', 'dark', 'light', 'system']),
        rng.chance(0.85) ? 'comfortable' : 'compact',
        ts(onboarded),
        ts(person.joinedMs),
        ts(onboarded),
      ]);
    }
    for (let p = personProjectStart[i]; p < personProjectStart[i + 1]; p++) {
      const created = projectCreatedMs(seedHash, p, person.joinedMs, nowMs);
      const topics = projectTopics(seedHash, p);
      const instructions = rng.chance(0.5)
        ? `${sentence(rng)} Focus on ${topics[0]} and ${topics[1]}. ${sentence(rng)}`
        : '';
      projects.row([
        id.project(p),
        ctx.organizationId,
        userId,
        text(`${title(rng).slice(0, 60)} ${topics[0]}`.slice(0, 100)),
        text(instructions.slice(0, 8000)),
        ts(created),
        ts(created + rng.float() * (nowMs - created)),
      ]);
    }
    await users.maybeFlush();
    await projects.maybeFlush();
  }
  const rows = {};
  for (const copy of [users, accounts, sessions, preferences, projects]) {
    rows[copy.table] = await copy.end();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Conversations: thread, message, attachment (message files), share_link
// ---------------------------------------------------------------------------

function assistantParts(rng, model, webSearch, length, status) {
  const parts = [{ type: 'step-start' }];
  let reasoningChars = 0;
  if (model.reasoning) {
    const reasoning = reasoningText(rng);
    reasoningChars = reasoning.length;
    parts.push({ type: 'reasoning', text: reasoning, state: 'done' });
  }
  if (webSearch) {
    const sources = rng.range(2, 5);
    for (let s = 0; s < sources; s++) {
      const host = `${word(rng).replace(/[^a-z]/g, '') || 'example'}.example.org`;
      parts.push({
        type: 'source-url',
        sourceId: `src_${rng.hex(6)}`,
        url: `https://${host}/${word(rng).replace(/[^a-z]/g, '')}-${rng.int(9999)}`,
        title: title(rng),
      });
    }
  }
  let body = assistantMarkdown(rng, length);
  if (status !== 'complete')
    body = body.slice(0, Math.max(20, Math.floor(body.length * rng.float())));
  parts.push({ type: 'text', text: body, state: 'done' });
  return { parts, chars: body.length + reasoningChars };
}

export async function conversationsTask(ctx, from, to) {
  const { sql, seedHash, nowMs, plan, models } = ctx;
  const id = ids(seedHash);
  const threads = await TextCopy.open(sql, 'thread', [
    'id',
    'organization_id',
    'user_id',
    'title',
    'pinned',
    'archived',
    'temporary',
    'expires_at',
    'last_message_at',
    'deleted_at',
    'deleted_reason',
    'import_source',
    'import_source_id',
    'project_id',
    'created_at',
    'updated_at',
  ]);
  const messages = await TextCopy.open(sql, 'message', [
    'id',
    'thread_id',
    'user_id',
    'role',
    'parts',
    'position',
    'parent_message_id',
    'model_slug',
    'effort',
    'web_search_used',
    'status',
    'error_message',
    'superseded_at',
    'tokens_in',
    'tokens_out',
    'duration_ms',
    'change_seq',
    'created_at',
    'updated_at',
  ]);
  const attachments = await TextCopy.open(sql, 'attachment', [
    'id',
    'organization_id',
    'user_id',
    'message_id',
    'filename',
    'mime_type',
    'size_bytes',
    'storage_key',
    'extracted_text',
    'deleted_at',
    'deleted_reason',
    'created_at',
    'updated_at',
  ]);
  const shares = await TextCopy.open(sql, 'share_link', [
    'id',
    'thread_id',
    'user_id',
    'slug',
    'up_to_message_id',
    'view_count',
    'expires_at',
    'revoked_at',
    'created_at',
    'updated_at',
  ]);
  const { convOwner, convMsgStart, convProject } = plan;
  const yearStart = nowMs - 365 * DAY_MS;
  const changeSeqFrom = nowMs - CHANGE_SEQ_DAYS * DAY_MS;
  const offsets = new Float64Array(1024);

  for (let c = from; c < to; c++) {
    const rng = new Rng(seedHash, hashString('conversation'), c);
    const ownerIndex = convOwner[c];
    const owner = personAttributes(seedHash, ownerIndex, nowMs);
    const userId = id.person(ownerIndex);
    const threadId = id.thread(c);
    const flags = conversationFlags(seedHash, c);
    // The restricted role has no attachments, share links or temporary chats
    // by default, so its people never made any.
    const restricted = owner.role === 'restricted';
    if (restricted) {
      flags.shared = false;
      flags.temporary = false;
    }
    const first = convMsgStart[c];
    const count = convMsgStart[c + 1] - first;
    const turns = Math.floor(count / 2);
    const retryTurn = count % 2 === 1 ? rng.int(turns) : -1;
    const model = pickWeighted(rng, models);

    // Times relative to the first message: replies take seconds, the next
    // turn follows after a minute or so, occasionally days later.
    const offsetsFor = offsets.length >= count ? offsets : new Float64Array(count);
    let t = 0;
    let position = 0;
    for (let k = 0; k < turns; k++) {
      offsetsFor[position++] = t;
      t += 4_000 + rng.lognormal(Math.log(9_000), 0.6);
      offsetsFor[position++] = t;
      if (k === retryTurn) {
        t += 20_000 + rng.float() * 60_000;
        offsetsFor[position++] = t;
      }
      t += rng.chance(0.04)
        ? rng.range(1, 20) * DAY_MS * rng.float()
        : rng.lognormal(Math.log(60_000), 1.2);
    }
    const span = offsetsFor[count - 1];
    let start;
    if (flags.temporary) start = nowMs - 2 * HOUR_MS - rng.float() * 8 * HOUR_MS;
    else {
      const room = Math.max(MINUTE_MS, nowMs - owner.joinedMs - HOUR_MS);
      start = owner.joinedMs + room * (1 - (1 - rng.float()) ** 1.5);
    }
    let compress = 1;
    const latest = nowMs - MINUTE_MS - rng.float() * 6 * HOUR_MS;
    if (start + span > latest) {
      start = Math.max(yearStart, latest - span);
      if (start + span > latest) compress = (latest - start) / span;
    }
    const lastMessageMs = start + span * compress;
    let deletedMs = null;
    if (flags.deleted) {
      deletedMs = Math.min(
        nowMs - MINUTE_MS,
        Math.max(lastMessageMs + MINUTE_MS, nowMs - rng.float() * 25 * DAY_MS),
      );
    }

    let contextChars = 2_000;
    let promptId = null;
    let lastId = null;
    position = 0;
    for (let k = 0; k < turns; k++) {
      const replies = k === retryTurn ? 2 : 1;
      // The user's message.
      const userIndex = first + position;
      const userMs = start + offsetsFor[position] * compress;
      const userId_ = id.message(userIndex);
      const prompt = userText(rng);
      const userParts = [{ type: 'text', text: prompt }];
      const files = rng.chance(0.03) && !restricted ? (rng.chance(0.1) ? 2 : 1) : 0;
      for (let a = 0; a < files; a++) {
        const kind = pickWeighted(rng, ATTACHMENT_KINDS);
        const attachmentId = id.upload(userIndex * 2 + a);
        const filename = `${word(rng).replace(/[^a-z]/g, '') || 'file'}-${rng.int(1000)}.${kind.ext}`;
        const size = Math.round(Math.min(20_000_000, Math.max(2_000, rng.lognormal(12.2, 1.3))));
        attachments.row([
          attachmentId,
          ctx.organizationId,
          userId,
          userId_,
          text(filename),
          kind.mime,
          String(size),
          `${userId}/${attachmentId}.${kind.ext}`,
          kind.text ? text(documentText(rng, [], rng.range(600, 3000))) : '\\N',
          ts(deletedMs),
          deletedMs === null ? '\\N' : 'thread',
          ts(userMs),
          ts(userMs),
        ]);
        userParts.push({
          type: 'data-attachment',
          data: {
            id: attachmentId,
            filename,
            mimeType: kind.mime,
            url: `/api/attachments/${attachmentId}/content`,
          },
        });
      }
      contextChars += prompt.length;
      messages.row([
        userId_,
        threadId,
        userId,
        'user',
        json(userParts),
        String(position),
        '\\N',
        model.slug,
        model.reasoning ? 'medium' : '\\N',
        'f',
        'complete',
        '\\N',
        '\\N',
        '\\N',
        '\\N',
        '\\N',
        userMs >= changeSeqFrom
          ? String((Math.floor(userMs) - CHANGE_SEQ_EPOCH) * 1000 + (userIndex % 1000))
          : '\\N',
        ts(userMs),
        ts(userMs),
      ]);
      promptId = userId_;
      lastId = userId_;
      position++;

      for (let r = 0; r < replies; r++) {
        const index = first + position;
        const replyMs = start + offsetsFor[position] * compress;
        const superseded = r < replies - 1;
        const roll = rng.float();
        const status = roll < 0.005 ? 'error' : roll < 0.008 ? 'cancelled' : 'complete';
        const webSearch = rng.chance(0.03);
        const length = Math.round(
          Math.min(12_000, Math.max(80, rng.lognormal(Math.log(900), 0.8))),
        );
        const { parts, chars } = assistantParts(rng, model, webSearch, length, status);
        const tokensOut = Math.ceil(chars / 4);
        const tokensIn = Math.min(CONTEXT_WINDOW_TOKENS, Math.ceil(contextChars / 4));
        const replyId = id.message(index);
        messages.row([
          replyId,
          threadId,
          userId,
          'assistant',
          json(parts),
          String(position),
          promptId,
          model.slug,
          model.reasoning ? 'medium' : '\\N',
          bool(webSearch),
          status,
          status === 'error' ? 'The model provider returned an error (502). Try again.' : '\\N',
          superseded ? ts(start + offsetsFor[position + 1] * compress) : '\\N',
          String(tokensIn),
          status === 'error' ? '\\N' : String(tokensOut),
          String(600 + tokensOut * 20),
          replyMs >= changeSeqFrom
            ? String((Math.floor(replyMs) - CHANGE_SEQ_EPOCH) * 1000 + (index % 1000))
            : '\\N',
          ts(replyMs),
          ts(replyMs),
        ]);
        if (!superseded) contextChars += chars;
        lastId = replyId;
        position++;
      }
    }

    const createdMs = start - 1_000;
    const touchedMs = flags.pinned || flags.archived ? lastMessageMs + MINUTE_MS : lastMessageMs;
    const projectIndex = convProject[c];
    const importSource = flags.imported ? (rng.chance(0.7) ? 'chatgpt' : 'claude') : null;
    threads.row([
      threadId,
      ctx.organizationId,
      userId,
      text(title(rng)),
      bool(flags.pinned),
      bool(flags.archived),
      bool(flags.temporary),
      flags.temporary ? ts(createdMs + 24 * HOUR_MS) : '\\N',
      ts(lastMessageMs),
      ts(deletedMs),
      deletedMs === null ? '\\N' : rng.chance(0.95) ? 'user' : 'admin',
      importSource ?? '\\N',
      importSource ? `conv-${c}` : '\\N',
      projectIndex >= 0 ? id.project(projectIndex) : '\\N',
      ts(createdMs),
      ts(Math.min(nowMs, Math.max(touchedMs, deletedMs ?? 0))),
    ]);

    if (flags.shared && !flags.deleted && !flags.temporary) {
      const links = rng.chance(0.15) ? 2 : 1;
      for (let s = 0; s < links; s++) {
        const created = lastMessageMs + rng.float() * (nowMs - lastMessageMs);
        const revoked = rng.chance(0.1);
        shares.row([
          id.share(c * 2 + s),
          threadId,
          userId,
          rng.token(24),
          rng.chance(0.5) ? lastId : '\\N',
          String(Math.min(5_000, Math.floor(rng.pareto(1.3)) - 1)),
          rng.chance(0.2) ? ts(created + 30 * DAY_MS) : '\\N',
          revoked ? ts(created + rng.float() * (nowMs - created)) : '\\N',
          ts(created),
          ts(created),
        ]);
      }
    }
    await messages.maybeFlush();
    await threads.maybeFlush();
    await attachments.maybeFlush();
    await shares.maybeFlush();
  }
  const rows = {};
  rows.thread = await threads.end();
  rows.message = await messages.end();
  rows['attachment (messages)'] = await attachments.end();
  rows.share_link = await shares.end();
  return rows;
}

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

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

const AUDIT_ACTIONS = [
  { weight: 0.62, action: 'auth.signin.local.success', target: 'session', status: 200 },
  { weight: 0.06, action: 'auth.signin.local.failure', target: 'session', status: 401 },
  { weight: 0.08, action: 'auth.signout.success', target: 'session', status: 200 },
  { weight: 0.12, action: 'tool.call', target: 'tool' },
  { weight: 0.03, action: 'thread.export', target: 'thread' },
  { weight: 0.01, action: 'share_link.revoke', target: 'share_link' },
  { weight: 0.02, action: 'auth.password.changed.success', target: 'session', status: 200 },
  { weight: 0.02, action: 'attachment.delete', target: 'attachment' },
  { weight: 0.04, action: 'admin', target: 'admin' },
];
const ADMIN_ACTIONS = ['settings.update', 'user.update', 'provider.update', 'job.run', 'ban'];

export async function auditTask(ctx, from, to, total) {
  const { sql, seedHash, nowMs, plan, adminIndexes } = ctx;
  const id = ids(seedHash);
  const copy = await TextCopy.open(sql, 'audit_log', [
    'id',
    'organization_id',
    'actor_user_id',
    'actor_email',
    'action',
    'target_type',
    'target_id',
    'metadata',
    'ip_address',
    'created_at',
    'seq',
  ]);
  const yearStart = nowMs - 365 * DAY_MS;
  const { convOwner } = plan;
  for (let i = from; i < to; i++) {
    const rng = new Rng(seedHash, hashString('audit'), i);
    // Monotonic in i, denser towards the present as adoption grows; `seq`
    // follows insertion (and so time) order, as the database's sequence does.
    const createdMs = yearStart + 365 * DAY_MS * ((i + rng.float()) / total) ** (2 / 3);
    const kind = pickWeighted(rng, AUDIT_ACTIONS);
    // An actor who had joined by then; the administrator (person 0) has been
    // there since launch.
    let actorIndex = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate =
        convOwner.length > 0 ? convOwner[rng.int(convOwner.length)] : rng.int(ctx.people);
      if (personAttributes(seedHash, candidate, nowMs).joinedMs <= createdMs) {
        actorIndex = candidate;
        break;
      }
    }
    let action = kind.action;
    let targetType = kind.target;
    let targetId = null;
    let metadata;
    if (kind.action === 'admin') {
      const admin = adminIndexes[rng.int(adminIndexes.length)];
      if (personAttributes(seedHash, admin, nowMs).joinedMs <= createdMs) actorIndex = admin;
      else actorIndex = 0;
      action = rng.pick(ADMIN_ACTIONS);
      targetType =
        action === 'settings.update' ? 'settings' : action === 'job.run' ? 'job' : 'user';
      targetId = targetType === 'user' ? id.person(rng.int(ctx.people)) : null;
      metadata = { changed: [word(rng)] };
    } else if (kind.action === 'tool.call') {
      targetId = 'web_search';
      metadata = {
        toolId: 'web_search',
        kind: 'builtin',
        approvalRequired: false,
        approval: null,
        outcome: rng.chance(0.97) ? 'success' : 'error',
      };
    } else if (kind.status) {
      metadata = { status: kind.status, userAgent: rng.pick(USER_AGENTS) };
    } else {
      targetId = id.thread(rng.int(Math.max(1, ctx.conversations)));
      metadata = {};
    }
    const actor = personAttributes(seedHash, actorIndex, nowMs);
    copy.row([
      id.audit(i),
      ctx.organizationId,
      id.person(actorIndex),
      actor.email,
      action,
      targetType,
      targetId ?? '\\N',
      json(metadata),
      ip(seedHash, 0x4001, actorIndex),
      ts(createdMs),
      String(i + 1),
    ]);
    await copy.maybeFlush();
  }
  return { audit_log: await copy.end() };
}

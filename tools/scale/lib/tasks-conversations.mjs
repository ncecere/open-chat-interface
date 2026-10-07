import { bool, json, TextCopy, text, ts } from './copy.mjs';
import { conversationFlags, DAY_MS, ids, personAttributes } from './plan.mjs';
import { hashString, Rng } from './prng.mjs';
import {
  ATTACHMENT_KINDS,
  CHANGE_SEQ_DAYS,
  CHANGE_SEQ_EPOCH,
  CONTEXT_WINDOW_TOKENS,
  HOUR_MS,
  MINUTE_MS,
  pickWeighted,
} from './tasks-common.mjs';
import { assistantMarkdown, documentText, reasoningText, title, userText, word } from './text.mjs';

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

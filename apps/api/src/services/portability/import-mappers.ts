/**
 * Maps one conversation from a ChatGPT or Claude export onto OCI messages.
 *
 * Neither company documents its format, so everything here is defensive:
 * any field may be missing or null, unknown content is counted rather than
 * fatal, and only what the person actually saw on screen is kept.
 */

export type ImportedSource = 'chatgpt' | 'claude';

export interface ImportedMessage {
  role: 'user' | 'assistant';
  parts: Record<string, unknown>[];
  createdAt: Date | null;
  modelSlug: string | null;
}

export interface ImportedConversation {
  source: ImportedSource;
  sourceId: string;
  title: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  messages: ImportedMessage[];
}

export interface MapResult {
  conversation: ImportedConversation | null;
  /** Unrecognised content or block types seen in this conversation. */
  unknownTypes: string[];
  /** Why the conversation produced nothing, when it did not. */
  reason?: 'empty' | 'invalid';
  /** Claude block content was present: the newer export layout. */
  usedContentBlocks?: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const UNTITLED = 'Imported conversation';
const MAX_TITLE_LENGTH = 200;

function cleanTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (title || UNTITLED).slice(0, MAX_TITLE_LENGTH);
}

/** ChatGPT uses float epoch seconds; Claude uses ISO strings. */
function epochSeconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function attachmentNote(names: string[], source: string): Json | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return null;
  return {
    type: 'text',
    text: `_Attached in ${source}: ${unique.join(', ')} (file not imported)_`,
  };
}

/**
 * Adds a message, merging consecutive assistant turns.
 *
 * Both exports can split one visible reply across several assistant nodes
 * (reasoning, then text; or a reply continued after a tool step). In OCI two
 * assistant messages under one prompt would read as regenerations instead.
 */
function pushMessage(messages: ImportedMessage[], message: ImportedMessage): void {
  if (message.parts.length === 0) return;
  const previous = messages.at(-1);
  if (previous && previous.role === 'assistant' && message.role === 'assistant') {
    previous.parts.push(...message.parts);
    previous.modelSlug ??= message.modelSlug;
    return;
  }
  messages.push(message);
}

/**
 * Drops turns with nothing visible (reasoning alone is never shown on its own),
 * then merges again: removing an empty prompt can leave two replies adjacent.
 */
function finishMessages(messages: ImportedMessage[]): ImportedMessage[] {
  const visible: ImportedMessage[] = [];
  for (const message of messages) {
    if (message.parts.some((part) => part.type === 'text' && String(part.text ?? '').trim())) {
      pushMessage(visible, message);
    }
  }
  return visible;
}

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

/** Content types that are tool or system internals, skipped silently. */
const CHATGPT_SKIPPED_TYPES = new Set([
  'user_editable_context',
  'model_editable_context',
  'reasoning_recap',
  'execution_output',
  'tether_quote',
  'tether_browsing_display',
  'sonic_webpage',
  'system_error',
  'computer_output',
]);

interface ChatGptNode {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: unknown;
}

/** When `current_node` is missing: the heaviest leaf, then the most recent. */
function fallbackLeaf(mapping: Record<string, ChatGptNode>): string | null {
  let best: { id: string; weight: number; time: number } | null = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (Array.isArray(node.children) && node.children.length > 0) continue;
    const message = isObject(node.message) ? node.message : {};
    const weight = typeof message.weight === 'number' ? message.weight : 1;
    const time =
      (typeof message.update_time === 'number' ? message.update_time : 0) ||
      (typeof message.create_time === 'number' ? message.create_time : 0);
    if (!best || weight > best.weight || (weight === best.weight && time > best.time)) {
      best = { id, weight, time };
    }
  }
  return best?.id ?? null;
}

/** The visible branch: from the current leaf up through its parents, then reversed. */
function chatGptVisiblePath(conversation: Json): ChatGptNode[] {
  const mapping = isObject(conversation.mapping)
    ? (conversation.mapping as Record<string, ChatGptNode>)
    : {};
  const current = asString(conversation.current_node);
  let cursor = current && mapping[current] ? current : fallbackLeaf(mapping);
  const path: ChatGptNode[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = mapping[cursor];
    if (!node) break;
    path.push(node);
    cursor = asString(node.parent);
  }
  return path.reverse();
}

function chatGptReasoning(content: Json): string {
  const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
  return thoughts
    .flatMap((thought) => {
      if (!isObject(thought)) return [];
      const text = asString(thought.content) ?? asString(thought.summary);
      return text ? [text.trim()] : [];
    })
    .filter(Boolean)
    .join('\n\n');
}

export function mapChatGptConversation(conversation: unknown): MapResult {
  const unknownTypes: string[] = [];
  if (!isObject(conversation)) return { conversation: null, unknownTypes, reason: 'invalid' };
  const sourceId = asString(conversation.conversation_id) ?? asString(conversation.id);
  if (!sourceId || !isObject(conversation.mapping)) {
    return { conversation: null, unknownTypes, reason: 'invalid' };
  }

  const messages: ImportedMessage[] = [];
  let pendingReasoning: string[] = [];

  for (const node of chatGptVisiblePath(conversation)) {
    const message = isObject(node.message) ? node.message : null;
    if (!message) continue;
    const metadata = isObject(message.metadata) ? message.metadata : {};
    if (metadata.is_visually_hidden_from_conversation === true) continue;

    const author = isObject(message.author) ? message.author : {};
    const role = author.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = isObject(message.content) ? message.content : {};
    const contentType = asString(content.content_type) ?? 'text';
    const recipient = asString(message.recipient) ?? 'all';
    const createdAt = epochSeconds(message.create_time);
    const modelSlug = role === 'assistant' ? asString(metadata.model_slug) : null;

    if (CHATGPT_SKIPPED_TYPES.has(contentType)) continue;

    if (contentType === 'thoughts') {
      const reasoning = chatGptReasoning(content);
      if (reasoning && role === 'assistant') pendingReasoning.push(reasoning);
      continue;
    }

    // A message addressed to a tool is an internal call, not something shown.
    if (recipient !== 'all') continue;

    const parts: Json[] = [];
    const attachmentNames: string[] = [];

    if (contentType === 'text' || contentType === 'multimodal_text') {
      const raw = Array.isArray(content.parts) ? content.parts : [];
      const texts: string[] = [];
      for (const part of raw) {
        if (typeof part === 'string') {
          if (part.trim()) texts.push(part);
        } else if (isObject(part)) {
          const partType = asString(part.content_type) ?? 'object';
          if (partType === 'image_asset_pointer') {
            attachmentNames.push('image');
          } else if (partType === 'audio_transcription' && asString(part.text)) {
            texts.push(part.text as string);
          } else if (partType !== 'audio_asset_pointer') {
            unknownTypes.push(`chatgpt.part.${partType}`);
          }
        }
      }
      if (texts.length > 0) parts.push({ type: 'text', text: texts.join('\n\n') });
    } else if (contentType === 'code') {
      const text = asString(content.text);
      if (text) {
        const language = asString(content.language) ?? '';
        parts.push({
          type: 'text',
          text: `\`\`\`${language === 'unknown' ? '' : language}\n${text}\n\`\`\``,
        });
      }
    } else {
      unknownTypes.push(`chatgpt.${contentType}`);
      continue;
    }

    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const attachment of attachments) {
      if (isObject(attachment) && asString(attachment.name)) {
        attachmentNames.push(attachment.name as string);
      }
    }
    // A named attachment replaces the generic "image" placeholder for the same file.
    const named = attachmentNames.filter((name) => name !== 'image');
    const note = attachmentNote(named.length > 0 ? named : attachmentNames, 'ChatGPT');
    if (note) parts.unshift(note);

    if (role === 'assistant' && pendingReasoning.length > 0 && parts.length > 0) {
      parts.unshift({ type: 'reasoning', text: pendingReasoning.join('\n\n') });
      pendingReasoning = [];
    }
    if (role === 'user') pendingReasoning = [];

    pushMessage(messages, { role, parts, createdAt, modelSlug });
  }

  const visible = finishMessages(messages);
  if (visible.length === 0) return { conversation: null, unknownTypes, reason: 'empty' };

  return {
    conversation: {
      source: 'chatgpt',
      sourceId,
      title: cleanTitle(conversation.title),
      createdAt: epochSeconds(conversation.create_time) ?? visible[0]?.createdAt ?? null,
      updatedAt: epochSeconds(conversation.update_time) ?? visible.at(-1)?.createdAt ?? null,
      messages: visible,
    },
    unknownTypes,
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** Block types that are tool internals or bookkeeping, skipped silently. */
const CLAUDE_SKIPPED_BLOCKS = new Set(['tool_use', 'tool_result', 'token_budget', 'image']);

/** Walks from the current leaf when the export carries parent links; otherwise array order. */
function claudeVisiblePath(conversation: Json): Json[] {
  const all = (Array.isArray(conversation.chat_messages) ? conversation.chat_messages : []).filter(
    isObject,
  );
  const leaf = asString(conversation.current_leaf_message_uuid);
  if (!leaf || !all.some((message) => asString(message.parent_message_uuid))) return all;

  const byId = new Map<string, Json>();
  for (const message of all) {
    const id = asString(message.uuid);
    if (id) byId.set(id, message);
  }
  if (!byId.has(leaf)) return all;

  const path: Json[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leaf;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = byId.get(cursor);
    if (!message) break;
    path.push(message);
    cursor = asString(message.parent_message_uuid);
  }
  return path.reverse();
}

function claudeFileNames(message: Json): string[] {
  const names: string[] = [];
  for (const key of ['attachments', 'files', 'files_v2']) {
    const list = message[key];
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      if (isObject(file) && asString(file.file_name)) names.push(file.file_name as string);
    }
  }
  return names;
}

export function mapClaudeConversation(conversation: unknown): MapResult {
  const unknownTypes: string[] = [];
  if (!isObject(conversation)) return { conversation: null, unknownTypes, reason: 'invalid' };
  const sourceId = asString(conversation.uuid);
  if (!sourceId || !Array.isArray(conversation.chat_messages)) {
    return { conversation: null, unknownTypes, reason: 'invalid' };
  }

  const model = asString(conversation.model);
  const messages: ImportedMessage[] = [];
  let usedContentBlocks = false;

  for (const message of claudeVisiblePath(conversation)) {
    const role =
      message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;

    const parts: Json[] = [];
    const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    if (blocks.length > 0) {
      usedContentBlocks = true;
      const texts: string[] = [];
      for (const block of blocks) {
        const type = asString(block.type) ?? 'unknown';
        if (type === 'text') {
          if (asString(block.text)?.trim()) texts.push(block.text as string);
        } else if (type === 'thinking') {
          const thinking = asString(block.thinking);
          if (thinking?.trim() && role === 'assistant') {
            parts.push({ type: 'reasoning', text: thinking });
          }
        } else if (type === 'voice_note') {
          if (asString(block.text)?.trim()) texts.push(block.text as string);
        } else if (!CLAUDE_SKIPPED_BLOCKS.has(type)) {
          unknownTypes.push(`claude.${type}`);
        }
      }
      if (texts.length > 0) parts.push({ type: 'text', text: texts.join('\n\n') });
    } else {
      const text = asString(message.text);
      if (text?.trim()) parts.push({ type: 'text', text });
    }

    const note = attachmentNote(claudeFileNames(message), 'Claude');
    if (note) parts.unshift(note);

    pushMessage(messages, {
      role,
      parts,
      createdAt: isoDate(message.created_at),
      modelSlug: role === 'assistant' ? model : null,
    });
  }

  const visible = finishMessages(messages);
  if (visible.length === 0) {
    return { conversation: null, unknownTypes, reason: 'empty', usedContentBlocks };
  }

  return {
    conversation: {
      source: 'claude',
      sourceId,
      title: cleanTitle(conversation.name),
      createdAt: isoDate(conversation.created_at) ?? visible[0]?.createdAt ?? null,
      updatedAt: isoDate(conversation.updated_at) ?? visible.at(-1)?.createdAt ?? null,
      messages: visible,
    },
    unknownTypes,
    usedContentBlocks,
  };
}

/** Format detection on one conversation object. */
export function detectConversationSource(value: unknown): ImportedSource | null {
  if (!isObject(value)) return null;
  if (isObject(value.mapping)) return 'chatgpt';
  if (Array.isArray(value.chat_messages) && asString(value.uuid)) return 'claude';
  return null;
}

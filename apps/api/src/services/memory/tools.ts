import { and, eq, schema } from '@oci/db';
import {
  FORGET_TOOL_ID,
  MAX_MEMORY_CHARS,
  type MemoryToolResult,
  REMEMBER_TOOL_ID,
} from '@oci/shared';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { forbidden } from '../../lib/errors.js';
import type { ToolCaller, ToolDefinition, ToolTurnInput } from '../tools/types.js';
import { memoryActive } from './access.js';
import { addMemory, forgetMemory } from './store.js';

/**
 * `remember` and `forget` (v0.9). Both are `read` tools in the approval sense:
 * they change only the person's own OCI data (their memories), never anything
 * outside OCI, every change is shown in the reply with an Undo action and in
 * Settings -> Memory, and the person opted in to memory themselves. Asking for
 * approval on each would add a step without protecting anything an Undo does
 * not already cover, which is the same reasoning as the artifact tools.
 *
 * They are governed by the role's `memory` switch rather than a per-tool role
 * setting, so they are not listed among a role's tools on Roles & access.
 */

/** Shared by both tools within one turn: one lookup of every switch. */
function active(turn: ToolTurnInput): Promise<boolean> {
  const key = 'memory:active';
  let pending = turn.memo.get(key) as Promise<boolean> | undefined;
  if (!pending) {
    pending = memoryActive({ userId: turn.userId, role: turn.role, temporary: turn.temporary });
    turn.memo.set(key, pending);
  }
  return pending;
}

/**
 * Checked again when a call runs: a switch may have changed since the turn
 * began, and a temporary chat must never write memory whatever the model asks.
 */
async function assertCallerMayWrite(caller: ToolCaller): Promise<void> {
  const [thread] = await db
    .select({ temporary: schema.thread.temporary })
    .from(schema.thread)
    .where(and(eq(schema.thread.id, caller.threadId), eq(schema.thread.userId, caller.userId)))
    .limit(1);
  const allowed =
    thread !== undefined &&
    (await memoryActive({
      userId: caller.userId,
      role: caller.role,
      temporary: thread.temporary,
    }));
  if (!allowed) throw forbidden('Memory is switched off, so nothing was saved or removed.');
}

export const rememberTool: ToolDefinition = {
  id: REMEMBER_TOOL_ID,
  label: 'Memory',
  description: [
    'Save a short note about the person to remember in future conversations.',
    'Use it when they ask you to remember something, or share a lasting preference or fact about themselves (their role, how they like answers, ongoing projects) that would help later.',
    'Write one self-contained fact in the third person, e.g. "Prefers metric units."',
    'Do not save passwords, secrets, or sensitive personal data unless they explicitly ask, and do not save things that only matter in this conversation.',
    'The person sees every saved note and can undo it.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    content: z
      .string()
      .trim()
      .min(1)
      .max(MAX_MEMORY_CHARS)
      .describe(`The note, at most ${MAX_MEMORY_CHARS} characters`),
  }),
  available: active,
  async execute(input, { caller }) {
    await assertCallerMayWrite(caller);
    const { row, created } = await addMemory(
      caller.userId,
      (input as { content: string }).content,
      {
        source: 'tool',
        via: 'tool',
        threadId: caller.threadId,
        messageId: caller.messageId,
      },
    );
    return {
      action: created ? 'added' : 'exists',
      id: row.id,
      content: row.content,
    } satisfies MemoryToolResult;
  },
};

export const forgetTool: ToolDefinition = {
  id: FORGET_TOOL_ID,
  label: 'Memory',
  description: [
    'Delete one saved note about the person, by the id shown in brackets before it in <user-memory>.',
    'Use it when they ask you to forget something or a note is no longer true; to correct a note, forget it and remember the corrected one.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    id: z.string().trim().min(4).max(40).describe('The id in brackets before the note'),
  }),
  available: active,
  async execute(input, { caller }) {
    await assertCallerMayWrite(caller);
    return forgetMemory(caller.userId, (input as { id: string }).id, {
      threadId: caller.threadId,
      messageId: caller.messageId,
    });
  },
};

export const memoryTools: readonly ToolDefinition[] = [rememberTool, forgetTool];

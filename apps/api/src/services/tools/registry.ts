import type { UserRole } from '@oci/shared';
import { type ToolSet, tool } from 'ai';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getSetting } from '../settings.js';
import { recordToolCall, type ToolApprovalAnswer } from './audit.js';
import { registeredTools } from './catalog.js';
import { resolveRoleToolAllowed } from './role-tools.js';
import type { ToolCaller, ToolDefinition, ToolTurnInput } from './types.js';

/** A stored or streamed tool result above this many characters is cut down. */
export const MAX_TOOL_RESULT_CHARS = 16_000;
const TOOL_TIMEOUT_MS = 30_000;

/** The tools offered to the model for one turn. Calls to anything else are refused. */
export interface TurnTools {
  definitions: ToolDefinition[];
}

export const NO_TOOLS: TurnTools = { definitions: [] };

export const hasTool = (tools: TurnTools, id: string) =>
  tools.definitions.some((definition) => definition.id === id);

export const toolDefinition = (tools: TurnTools, id: string) =>
  tools.definitions.find((definition) => definition.id === id);

/**
 * The tool set for one turn: tools enabled on the instance (and, where the
 * composer has a switch, for this message), allowed for the person's role,
 * usable by the model (`tool_calling`) and, for an OAuth connector, connected
 * by this person. A model without tool calling gets none and behaves exactly
 * as in v0.7.
 */
export async function resolveTurnTools(turn: {
  role: UserRole;
  userId: string;
  capabilities: readonly string[];
  webSearch: boolean;
}): Promise<TurnTools> {
  if (!turn.capabilities.includes('tool_calling')) return NO_TOOLS;
  const [stored, registered] = await Promise.all([getSetting('roleTools'), registeredTools()]);
  const input: ToolTurnInput = {
    role: turn.role,
    userId: turn.userId,
    webSearch: turn.webSearch,
    memo: new Map(),
  };
  const offered: ToolDefinition[] = [];
  for (const definition of registered) {
    if (!resolveRoleToolAllowed(turn.role, definition, stored)) continue;
    if (!(await definition.available(input))) continue;
    offered.push(definition);
  }
  return { definitions: offered };
}

/** A failure whose message is safe to show the person and the model. */
export class ToolFailure extends Error {}

/** Message for a failed tool step: our own wording, never an internal error. */
export function toolErrorText(error: unknown): string {
  return error instanceof ToolFailure ? error.message : 'An error occurred.';
}

/**
 * Bounds a result before the model or storage sees it. The model sees exactly
 * what is stored, so later turns read the same capped text.
 */
export function capToolResult(value: unknown): { value: unknown; bytes: number } {
  const serialized = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return { value: value ?? null, bytes };
  return {
    value: {
      truncated: true,
      text: serialized.slice(0, MAX_TOOL_RESULT_CHARS),
    },
    bytes,
  };
}

/** Write tools always need approval; read tools never do. */
export function toolApprovalPolicy(tools: TurnTools) {
  return ({ toolCall }: { toolCall: { toolName: string } }) =>
    toolDefinition(tools, toolCall.toolName)?.kind === 'write'
      ? ('user-approval' as const)
      : undefined;
}

/**
 * SDK tools for one run. Each execution is time-limited, size-capped and
 * audited (metadata only). `approved` lists tool calls the person approved in
 * this continuation, so their audit event records the answer.
 */
export function buildSdkTools(
  tools: TurnTools,
  caller: ToolCaller,
  approved: ReadonlySet<string> = new Set(),
): ToolSet {
  return Object.fromEntries(
    tools.definitions.map((definition) => [
      definition.id,
      tool({
        // Streams onto the stored tool part, so every renderer can name it.
        title: definition.label,
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input: unknown, options) => {
          const started = Date.now();
          const signal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(TOOL_TIMEOUT_MS)])
            : AbortSignal.timeout(TOOL_TIMEOUT_MS);
          const approval: ToolApprovalAnswer | null = approved.has(options.toolCallId)
            ? 'approved'
            : null;
          const audit = (outcome: 'ok' | 'error', resultBytes: number | null) =>
            recordToolCall({
              userId: caller.userId,
              toolId: definition.id,
              kind: definition.kind,
              threadId: caller.threadId,
              messageId: caller.messageId,
              outcome,
              approvalRequired: definition.kind === 'write',
              approval,
              durationMs: Date.now() - started,
              resultBytes,
            });
          let raw: unknown;
          try {
            raw = await definition.execute(input, { signal, caller });
          } catch (error) {
            await audit('error', null);
            if (!(error instanceof AppError))
              logger.warn({ err: error, toolId: definition.id }, 'Tool call failed');
            throw new ToolFailure(
              // AppError messages are written for people; anything else is internal.
              error instanceof AppError
                ? error.message
                : `${definition.label} failed. Try again later.`,
            );
          }
          const capped = capToolResult(raw);
          await audit('ok', capped.bytes);
          return capped.value;
        },
      }),
    ]),
  );
}

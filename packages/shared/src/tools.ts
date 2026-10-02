import { z } from 'zod';
import { USER_ROLES, type UserRole } from './constants.js';

/**
 * Tools a model can call during a reply (v0.8). The server registry holds the
 * executable definitions; this module holds what clients and every renderer
 * (conversation, share links, exports) need to describe a tool step.
 */

/** `read` tools look something up; `write` tools change something elsewhere and always need approval. */
export const TOOL_KINDS = ['read', 'write'] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/**
 * Built-in tool ids, and the shape of a connector tool id
 * (`mcp__<connector>__<tool>`). Every id is also the function name sent to the
 * provider, so it keeps to the characters and length OpenAI and Anthropic
 * accept (`^[A-Za-z0-9_-]{1,64}$`). A connector slug has no underscores, so
 * the first `__` after `mcp__` always ends it.
 */
export const TOOL_ID_PATTERN =
  /^(?:[a-z][a-z0-9_]{0,63}|mcp__[a-z0-9-]{1,24}__[A-Za-z0-9_-]{1,57})$/;
export const MAX_TOOL_ID_LENGTH = 64;

/** A connector's slug: lowercase letters, digits and inner hyphens, at most 24 characters. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;

/** `mcp__<slug>__<key>`: the id of a connector tool. */
export function connectorToolId(slug: string, key: string): string {
  return `mcp__${slug}__${key}`;
}

/** The connector slug a tool id belongs to, or null for a built-in tool. */
export function connectorSlugOfToolId(toolId: string): string | null {
  const match = /^mcp__([a-z0-9-]{1,24})__./.exec(toolId);
  return match?.[1] ?? null;
}

export interface ToolDescriptor {
  id: string;
  label: string;
  kind: ToolKind;
  /** `builtin` tools ship with OCI; connector tools come from MCP servers. */
  source: 'builtin' | 'connector';
}

/** Model steps per reply: default and the range an administrator may choose. */
export const DEFAULT_MAX_TOOL_STEPS = 8;
export const MIN_TOOL_STEPS = 1;
export const MAX_TOOL_STEPS = 20;

/** Reason sent to the model when an approval was never answered. */
export const APPROVAL_NOT_ANSWERED = 'not answered';

/**
 * Whether a role may use a tool when nobody has saved a choice for it. Built-in
 * read tools are on for every role except `restricted`; anything else (write
 * tools, connector tools) is off until an administrator allows it.
 */
export function defaultToolAllowed(role: UserRole, tool: Pick<ToolDescriptor, 'kind' | 'source'>) {
  return tool.source === 'builtin' && tool.kind === 'read' && role !== 'restricted';
}

/** Body of `PUT /admin/roles/:role/tools`: only sent tools change. */
export const updateRoleToolsSchema = z
  .object({
    tools: z
      .record(
        z.string().max(MAX_TOOL_ID_LENGTH).regex(TOOL_ID_PATTERN, 'Unknown tool id'),
        z.boolean(),
      )
      .refine((tools) => Object.keys(tools).length > 0, { message: 'Send at least one change.' })
      .refine((tools) => Object.keys(tools).length <= 200, { message: 'Too many tools.' }),
  })
  .strict();
export type UpdateRoleToolsInput = z.infer<typeof updateRoleToolsSchema>;

export const roleToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(TOOL_KINDS),
  source: z.enum(['builtin', 'connector']),
  allowed: z.boolean(),
  /** The connector's name, for grouping connector tools; absent for built-in tools. */
  connector: z.string().nullable().optional(),
});
export type RoleTool = z.infer<typeof roleToolSchema>;

export const roleToolsResponseSchema = z.object({
  role: z.enum(USER_ROLES),
  tools: z.array(roleToolSchema),
});

/** Body of `POST /api/chat/:threadId/approvals`: answers to every open approval of one reply. */
export const answerToolApprovalsSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    responses: z
      .array(
        z
          .object({
            approvalId: z.string().min(1).max(200),
            approved: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type AnswerToolApprovalsInput = z.infer<typeof answerToolApprovalsSchema>;

/** Why a reply's tool loop ended early, stored as a `data-tool-limit` part. */
export const TOOL_LIMIT_REASONS = ['steps', 'allowance', 'context'] as const;
export type ToolLimitReason = (typeof TOOL_LIMIT_REASONS)[number];

export function toolLimitNote(reason: ToolLimitReason, steps?: number): string {
  if (reason === 'allowance')
    return 'This reply stopped using tools because your usage allowance ran out.';
  if (reason === 'context')
    return 'This reply stopped using tools because the results no longer fit the model’s input limit.';
  return `This reply reached the limit of ${steps ?? DEFAULT_MAX_TOOL_STEPS} steps and stopped.`;
}

/** Labels for tools this release knows about; unknown ids fall back to the id. */
const KNOWN_TOOL_LABELS: Record<string, string> = { web_search: 'Web search' };

export function toolLabel(toolId: string): string {
  return KNOWN_TOOL_LABELS[toolId] ?? toolId;
}

export type ToolStepState =
  | 'running'
  | 'awaiting-approval'
  | 'approved'
  | 'done'
  | 'error'
  | 'denied';

/** A tool step as every renderer shows it: never the raw result. */
export interface ToolStepSummary {
  toolCallId: string;
  toolId: string;
  label: string;
  state: ToolStepState;
  /** One line, e.g. "Searched the web for 'opening hours' · 5 results". */
  summary: string;
  /** Set while the step waits for the person's answer. */
  approvalId: string | null;
  /** Denial reason, such as "not answered". */
  reason: string | null;
}

type PartLike = Record<string, unknown>;

/** True for a stored or streaming SDK tool part (`tool-<id>` or `dynamic-tool`). */
export function isToolPart(part: unknown): part is PartLike & { type: string; toolCallId: string } {
  if (typeof part !== 'object' || part === null) return false;
  const candidate = part as PartLike;
  return (
    typeof candidate.type === 'string' &&
    (candidate.type.startsWith('tool-') || candidate.type === 'dynamic-tool') &&
    typeof candidate.toolCallId === 'string'
  );
}

export function toolIdOfPart(part: PartLike): string {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : '';
  return String(part.type).slice('tool-'.length);
}

function stepState(part: PartLike): ToolStepState {
  switch (part.state) {
    case 'approval-requested':
      return 'awaiting-approval';
    case 'approval-responded':
      return (part.approval as { approved?: unknown } | undefined)?.approved === true
        ? 'approved'
        : 'denied';
    case 'output-available':
      return 'done';
    case 'output-error':
      return 'error';
    case 'output-denied':
      return 'denied';
    default:
      return 'running';
  }
}

const quote = (value: string) => {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return `'${trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed}'`;
};

function inputQuery(part: PartLike): string | null {
  const input = part.input as { query?: unknown } | undefined;
  return typeof input?.query === 'string' && input.query.trim() ? input.query : null;
}

function resultCount(part: PartLike): number | null {
  const output = part.output as { results?: unknown } | undefined;
  return Array.isArray(output?.results) ? output.results.length : null;
}

/** Summarise one tool part. Results are reduced to counts; inputs to a short phrase. */
export function summarizeToolPart(part: PartLike): ToolStepSummary {
  const toolId = toolIdOfPart(part);
  // The server streams each tool's label as the part's title.
  const label =
    typeof part.title === 'string' && part.title.trim()
      ? part.title.trim().slice(0, 120)
      : toolLabel(toolId);
  const state = stepState(part);
  const approval = part.approval as { id?: unknown; reason?: unknown } | undefined;
  let summary: string;
  if (toolId === 'web_search') {
    const query = inputQuery(part);
    const target = query ? ` for ${quote(query)}` : '';
    if (state === 'done') {
      const count = resultCount(part) ?? 0;
      summary = `Searched the web${target} · ${count} ${count === 1 ? 'result' : 'results'}`;
    } else if (state === 'error') summary = `Web search${target} failed`;
    else if (state === 'denied') summary = `Web search${target} was not run`;
    else summary = `Searching the web${target}`;
  } else if (state === 'done') summary = `Used ${label}`;
  else if (state === 'error') summary = `${label} failed`;
  else if (state === 'denied') summary = `${label} was not run`;
  else if (state === 'awaiting-approval') summary = `${label} is waiting for your approval`;
  else summary = `Using ${label}`;
  const reason = typeof approval?.reason === 'string' ? approval.reason : null;
  if (state === 'denied' && reason) summary = `${summary} (${reason})`;
  return {
    toolCallId: String(part.toolCallId),
    toolId,
    label,
    state,
    summary,
    approvalId:
      state === 'awaiting-approval' && typeof approval?.id === 'string' ? approval.id : null,
    reason,
  };
}

/** Every tool step of a message, in order. */
export function toolStepsOf(parts: unknown): ToolStepSummary[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter(isToolPart).map(summarizeToolPart);
}

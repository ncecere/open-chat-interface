import type { ToolKind, UserRole } from '@oci/shared';
import type { FlexibleSchema } from 'ai';

/** Who is calling a tool, and in which conversation. Never written to the audit log beyond ids. */
export interface ToolCaller {
  userId: string;
  role: UserRole;
  threadId: string;
  messageId: string;
}

/** What decides whether a tool is offered for one turn, besides role and model. */
export interface ToolTurnInput {
  role: UserRole;
  /** The composer's Search switch for this message. */
  webSearch: boolean;
}

/**
 * One tool OCI can offer a model. Built-in tools use Zod input schemas; MCP
 * connector tools (later) will use JSON Schema through the same field.
 */
export interface ToolDefinition {
  /** `web_search`, or `mcp.<connector>.<tool>` for connector tools. */
  id: string;
  label: string;
  /** What the model reads to decide when to call it. */
  description: string;
  kind: ToolKind;
  source: 'builtin' | 'connector';
  inputSchema: FlexibleSchema;
  /**
   * Whether the tool is switched on for this turn on the instance and, where
   * the composer has a switch, for this message. Role and model are checked by
   * the registry.
   */
  available: (turn: ToolTurnInput) => Promise<boolean> | boolean;
  /** Returns a JSON-serialisable result; the registry caps its size. */
  execute: (
    input: unknown,
    options: { signal: AbortSignal; caller: ToolCaller },
  ) => Promise<unknown>;
}

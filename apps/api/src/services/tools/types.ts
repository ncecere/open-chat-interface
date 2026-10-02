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
  /** The person the turn is for: connector tools need their own connection. */
  userId: string;
  /** The composer's Search switch for this message. */
  webSearch: boolean;
  /** A temporary chat: never offered tools that read or write memory. */
  temporary: boolean;
  /**
   * Shared by every tool's `available` check in one turn, so a lookup several
   * tools need (such as the person's connector accounts) runs once.
   */
  memo: Map<string, Promise<unknown>>;
}

/** A link a tool result points at, shown as a source of the reply. */
export interface ToolSource {
  url: string;
  title: string;
}

/**
 * One tool OCI can offer a model. Built-in tools use Zod input schemas; MCP
 * connector tools use the server's JSON Schema through the same field.
 */
export interface ToolDefinition {
  /** `web_search`, or `mcp__<connector>__<tool>` for connector tools. */
  id: string;
  label: string;
  /** What the model reads to decide when to call it. */
  description: string;
  kind: ToolKind;
  source: 'builtin' | 'connector';
  /** The connector a connector tool comes from. */
  connector?: { id: string; name: string; slug: string };
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
  /** Links in a finished result to show as the reply's sources, in order. */
  sources?: (output: unknown) => ToolSource[];
}

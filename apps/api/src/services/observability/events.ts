import {
  chatReplies,
  chatReplyDuration,
  jobDuration,
  jobRuns,
  toolCallDuration,
  toolCalls,
} from './metrics.js';
import { recordSpan } from './tracing.js';

/**
 * One place where application events become metrics and spans, so call sites
 * stay one line and never decide what is safe to export: only fixed
 * vocabularies, configured names and durations pass through here.
 */

const REPLY_STATUSES = new Set(['complete', 'error', 'cancelled']);

/** A tool id is configuration (`web_search`, `mcp__docs__search`); anything else is collapsed. */
function toolLabel(toolId: string): string {
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(toolId) ? toolId : 'other';
}

/** A chat reply finished generating (or failed, or was stopped). */
export function observeChatReply(status: string, startedAt: number): void {
  const label = REPLY_STATUSES.has(status) ? status : 'other';
  const now = Date.now();
  chatReplies.inc({ status: label });
  chatReplyDuration.observe({ status: label }, Math.max(0, now - startedAt) / 1000);
  recordSpan('chat.reply', { 'oci.reply.status': label }, startedAt, {
    endTime: now,
    ...(label === 'error' ? { failed: 'reply failed' } : {}),
  });
}

/** A tool call ended; `durationMs` is null for calls that never ran (denied or refused). */
export function observeToolCall(toolId: string, outcome: string, durationMs: number | null): void {
  const tool = toolLabel(toolId);
  toolCalls.inc({ tool, outcome });
  if (durationMs === null) return;
  toolCallDuration.observe({ tool }, durationMs / 1000);
  const end = Date.now();
  recordSpan('tool.call', { 'oci.tool.id': tool, 'oci.tool.outcome': outcome }, end - durationMs, {
    endTime: end,
    ...(outcome === 'error' ? { failed: 'tool call failed' } : {}),
  });
}

/** A background job run ended. */
export function observeJob(name: string, outcome: 'success' | 'error', durationMs: number): void {
  jobRuns.inc({ job: name, outcome });
  jobDuration.observe({ job: name }, durationMs / 1000);
}

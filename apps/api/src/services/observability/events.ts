import {
  chatReplies,
  chatReplyDuration,
  chatReplyStart,
  drainInterruptedReplies,
  jobDuration,
  jobLastSuccess,
  jobRuns,
  providerFirstOutput,
  readinessTransitions,
  toolCallDuration,
  toolCalls,
  webSearchDuration,
  webSearches,
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
  if (outcome === 'success') jobLastSuccess.set({ job: name }, Math.floor(Date.now() / 1000));
}

/**
 * The time OCI added before a reply's first model request (docs/dev/slo.md):
 * since the request arrived, less the wait for provider capacity.
 */
export function observeReplyStart(addedMs: number): void {
  chatReplyStart.observe({}, Math.max(0, addedMs) / 1000);
}

/** From a reply's first model request to its first output, retries included. */
export function observeProviderFirstOutput(provider: string, model: string, ms: number): void {
  providerFirstOutput.observe({ provider, model }, Math.max(0, ms) / 1000);
}

/** A reply saved as interrupted because the drain limit ran out (v0.11 design, item 13). */
export function observeDrainInterruptedReply(): void {
  drainInterruptedReplies.inc();
}

let lastReadiness: boolean | null = null;

/** The readiness probe's answer; only changes are counted. */
export function observeReadiness(ready: boolean): void {
  if (lastReadiness !== null && lastReadiness !== ready)
    readinessTransitions.inc({ to: ready ? 'ready' : 'not_ready' });
  lastReadiness = ready;
}

/** Test seam. */
export function resetReadinessForTests(): void {
  lastReadiness = null;
}

/**
 * One provider's part in a web search from a conversation (v0.10): the
 * provider kind (a fixed vocabulary), whether it was the primary or the
 * fallback, and whether it answered. Never the query.
 */
export function observeWebSearch(
  provider: string,
  slot: 'primary' | 'fallback',
  outcome: 'answered' | 'failed',
  durationMs: number,
): void {
  const label = /^[a-z]{1,20}$/.test(provider) ? provider : 'other';
  webSearches.inc({ provider: label, slot, outcome });
  webSearchDuration.observe({ provider: label, slot }, Math.max(0, durationMs) / 1000);
}

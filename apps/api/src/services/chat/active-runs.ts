/**
 * Replies being written by this process, so a shutdown can wait for them and,
 * past its limit, stop them in a way that saves what they have (v0.11 design,
 * item 13). A reply counts from just before its model starts until its final
 * save, usage settlement and stream finalization are done.
 */

/** Abort reason for a reply stopped by shutdown rather than by the person. */
export const SHUTDOWN_ABORT_REASON = 'shutdown';

const runs = new Map<string, AbortController>();
let interrupting = false;

/** Returns the function that marks the run finished; safe to call twice. */
export function trackRun(runId: string, abort: AbortController): () => void {
  runs.set(runId, abort);
  // A turn admitted before the drain may only reach its model after the limit.
  if (interrupting) abort.abort(SHUTDOWN_ABORT_REASON);
  return () => {
    if (runs.get(runId) === abort) runs.delete(runId);
  };
}

export function isRunActiveHere(runId: string): boolean {
  return runs.has(runId);
}

export function activeRunCount(): number {
  return runs.size;
}

/** Stops every reply still running; each saves what it has as interrupted. */
export function interruptActiveRuns(): number {
  interrupting = true;
  for (const abort of runs.values()) abort.abort(SHUTDOWN_ABORT_REASON);
  return runs.size;
}

export function stoppedByShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === SHUTDOWN_ABORT_REASON;
}

/** Test seam. */
export function resetActiveRunsForTests(): void {
  runs.clear();
  interrupting = false;
}

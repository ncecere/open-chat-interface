export type ReplayValidator<T = boolean> = (signal: AbortSignal) => Promise<T>;

const VALIDATION_TIMEOUT_MS = 2000;

/**
 * Bound this reader's wait and signal work to stop. The validator must also bound
 * its underlying I/O; a Promise deadline alone cannot cancel a database command.
 * Callers await one validation and stop the reader on failure, never start a
 * detached polling loop that accumulates overlapping checks.
 */
export async function validateReplayRun<T>(
  validate: ReplayValidator<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const deadline = new AbortController();
  const scoped = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(scoped.reason);
    scoped.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => {
    deadline.abort(new Error('Durable replay validation timed out'));
  }, VALIDATION_TIMEOUT_MS);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        scoped.throwIfAborted();
        return validate(scoped);
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    scoped.removeEventListener('abort', onAbort);
    deadline.abort();
  }
}

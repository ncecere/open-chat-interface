import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A lock between the browser tests' worker processes, for a step that reads the
 * instance and then changes it ("is it there? no: make it"), which two workers
 * doing at once would both get wrong. `mkdir` is atomic, so the directory is
 * the lock. Held for the few requests of one step, never for a whole test.
 */

/** A lock left by a run that died is older than any step takes. */
const STALE_AFTER_MS = 30_000;
const WAIT_LIMIT_MS = 60_000;

export async function withProcessLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const lock = join(tmpdir(), `oci-e2e-${name}.lock`);
  for (let waitedMs = 0; ; waitedMs += 100) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > STALE_AFTER_MS) await rm(lock, { recursive: true, force: true });
      if (waitedMs > WAIT_LIMIT_MS) throw new Error(`The "${name}" lock stayed taken`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

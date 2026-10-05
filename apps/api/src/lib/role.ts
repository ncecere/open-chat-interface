import { loadEnv } from '../config/env.js';

/**
 * What this process does (OCI_ROLE; v0.11 design, item 14).
 *
 * | Role     | Serves the API | Runs background jobs |
 * | -------- | -------------- | -------------------- |
 * | `all`    | yes            | yes (the default)    |
 * | `web`    | yes            | no: queues them      |
 * | `worker` | health, metrics| yes                  |
 */
export type ProcessRole = 'web' | 'worker' | 'all';

export function processRole(): ProcessRole {
  // Test environments may stub the environment without a role: that is `all`.
  return loadEnv().OCI_ROLE ?? 'all';
}

/** Whether this process runs the job runner and work queued for it. */
export function runsBackgroundJobs(): boolean {
  return processRole() !== 'web';
}

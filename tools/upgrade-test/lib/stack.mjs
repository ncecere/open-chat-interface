// Compose stack housekeeping: log collection and teardown.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compose } from '../lib.mjs';
import { bases, env, log, options, outDir } from './context.mjs';

/* ------------------------------------------------------------------------ */

export async function collectLogs(services) {
  const logDir = join(outDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  for (const service of services) {
    const r = await compose(['logs', '--no-color', '--timestamps', service], env);
    writeFileSync(join(logDir, `${service}.log`), r.stdout + r.stderr);
  }
}

export async function teardown() {
  if (options.keep) {
    log(`--keep: leaving compose project oci-upgrade running (web on ${bases.join(', ')})`);
    return;
  }
  await compose(['--profile', 'tools', 'down', '-v', '--remove-orphans', '--timeout', '5'], env);
}

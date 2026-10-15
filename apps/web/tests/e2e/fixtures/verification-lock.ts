import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect } from '@playwright/test';

/**
 * Making an account that can sign in, in a fixture that cannot send mail.
 *
 * An account an administrator creates is verified only if the instance does not
 * require verified addresses at that moment, and the browser-test fixture
 * requires them yet delivers no mail. So the requirement is lifted while the
 * account is made and put back after. It is one setting of the whole instance
 * and the specs run in parallel worker processes, so two specs doing this at
 * once break each other: one restores the requirement between the other's lift
 * and its creation, and that account can never sign in ("not verified, and
 * this service cannot send email").
 *
 * Every spec that makes accounts therefore does it through this function, which
 * serialises the lift, the creation and the restore between worker processes
 * with a lock directory (`mkdir` is atomic). The lock is held for the few
 * requests of one creation, not for a test.
 */
const LOCK = join(tmpdir(), 'oci-e2e-verification-setting.lock');

/** A lock left by a run that died is older than any creation takes. */
const STALE_AFTER_MS = 30_000;

async function acquire(): Promise<void> {
  for (let waited = 0; ; waited += 1) {
    try {
      await mkdir(LOCK);
      return;
    } catch {
      const age = await stat(LOCK).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > STALE_AFTER_MS) await rm(LOCK, { recursive: true, force: true });
      if (waited > 600) throw new Error('The verification setting stayed locked');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Runs `work` (the account creations) with email verification not required,
 * as the administrator `admin` is signed in on, and puts the setting back
 * afterwards, even when `work` throws. The value is read inside the lock:
 * outside it, what is read may be another caller's lift.
 */
export async function whileVerificationLifted<T>(
  admin: APIRequestContext,
  work: () => Promise<T>,
): Promise<T> {
  await acquire();
  try {
    const settings = await admin.get('/api/admin/settings');
    expect(settings.ok()).toBe(true);
    const { emailVerificationRequired } = (await settings.json()) as {
      emailVerificationRequired: boolean;
    };
    try {
      if (emailVerificationRequired) {
        const lifted = await admin.patch('/api/admin/settings', {
          data: { emailVerificationRequired: false },
        });
        expect(lifted.ok(), await lifted.text()).toBe(true);
      }
      return await work();
    } finally {
      if (emailVerificationRequired) {
        const restored = await admin.patch('/api/admin/settings', {
          data: { emailVerificationRequired: true },
        });
        expect(restored.ok(), await restored.text()).toBe(true);
      }
    }
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
}

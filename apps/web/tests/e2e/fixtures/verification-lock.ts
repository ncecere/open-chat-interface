import { type APIRequestContext, expect } from '@playwright/test';
import { withProcessLock } from './process-lock';

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
 * with a lock (process-lock.ts). The lock is held for the few requests of one
 * creation, not for a test.
 */
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
  return withProcessLock('verification-setting', async () => {
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
  });
}

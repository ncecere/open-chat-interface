import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';
import { useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/**
 * How long after a verification email the button waits before offering
 * another (#330): a sign-in that is refused for an unverified address has
 * just sent a link, so Resend straight after it only sent a duplicate. The
 * API skips a verification email to an account that was sent one within the
 * same minute (services/account-email-delivery.ts), so pressing sooner would
 * not send one anyway.
 */
export const RESEND_COOLDOWN_MS = 60_000;

/** Delivery can recover without recreating the account or reusing an invitation. */
export function ResendVerification({
  email,
  sentAt,
  emailFieldId,
}: {
  email: string;
  /**
   * The page's own Email field, when it has one to fill in (the verify-email
   * page): pressing Resend without an address moves the cursor there (#337).
   */
  emailFieldId?: string;
  /** When a link was just sent for this address (a refused sign-in sends one). */
  sentAt?: number;
}) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'sending' | 'requested' | 'error'>('idle');
  const [waitUntil, setWaitUntil] = useState(() => (sentAt ? sentAt + RESEND_COOLDOWN_MS : 0));
  const [now, setNow] = useState(() => Date.now());
  const waiting = waitUntil > now;
  const missingEmail = !email.trim();

  // One re-render when the wait ends, not a ticking countdown that a screen
  // reader would announce every second.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(
      // A timer can fire a moment before Date.now() reaches the time it was set for; the
      // wait is over once it has fired. Reading the clock alone left the button disabled
      // (nothing set another timer) until something else re-rendered the page.
      () => setNow(Math.max(Date.now(), waitUntil)),
      waitUntil - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [waiting, waitUntil]);

  async function resend() {
    if (missingEmail) {
      // Say what is missing and take the person to it, rather than doing nothing.
      if (emailFieldId) document.getElementById(emailFieldId)?.focus();
      return;
    }
    if (state === 'sending' || waiting) return;
    setState('sending');
    try {
      const result = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: '/',
      });
      setState(result.error ? 'error' : 'requested');
      if (!result.error) {
        const sent = Date.now();
        setNow(sent);
        setWaitUntil(sent + RESEND_COOLDOWN_MS);
      }
    } catch {
      setState('error');
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        // With no address the button stays in the tab order and says why
        // (aria-disabled, not disabled), as the shared Button does for a
        // button that is busy (#337, #269): a native disabled button was
        // skipped by Tab and gave a screen reader nothing to read.
        disabled={state === 'sending' || waiting}
        aria-disabled={missingEmail || undefined}
        className={cn('w-full', missingEmail && 'opacity-50')}
        aria-describedby={waiting ? 'resend-wait' : missingEmail ? 'resend-needs-email' : undefined}
        onClick={() => void resend()}
      >
        {state === 'sending' ? t('auth.resend.requesting') : t('auth.resend.button')}
      </Button>
      {missingEmail && !waiting && (
        <p id="resend-needs-email" className="text-xs text-[var(--text-muted)]">
          {t('auth.resend.needsEmail')}
        </p>
      )}
      {state === 'requested' && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          {t('auth.resend.requested')}
        </p>
      )}
      {waiting && (
        <p id="resend-wait" className="text-xs text-[var(--text-muted)]">
          {/* After a request, nothing more: it does not say whether one was sent (#328). */}
          {state === 'requested'
            ? t('auth.resend.waitAfterRequest')
            : t('auth.resend.waitJustSent')}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          {t('auth.resend.error')}
        </p>
      )}
    </div>
  );
}

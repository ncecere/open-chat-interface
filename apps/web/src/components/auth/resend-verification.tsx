import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';
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
        {state === 'sending' ? 'Requesting email...' : 'Resend verification email'}
      </Button>
      {missingEmail && !waiting && (
        <p id="resend-needs-email" className="text-xs text-[var(--text-muted)]">
          Enter your email address above to ask for a link.
        </p>
      )}
      {state === 'requested' && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          If this address needs verification, check its inbox and spam folder. If no email arrives,
          try again later or contact an administrator to check email delivery.
        </p>
      )}
      {waiting && (
        <p id="resend-wait" className="text-xs text-[var(--text-muted)]">
          {/* After a request, nothing more: it does not say whether one was sent (#328). */}
          {state === 'requested'
            ? 'You can ask again in a minute.'
            : 'A link was just sent. You can ask for another in a minute if it does not arrive.'}
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
          Could not request a verification email. Try again later or contact an administrator.
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';

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
}: {
  email: string;
  /** When a link was just sent for this address (a refused sign-in sends one). */
  sentAt?: number;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'requested' | 'error'>('idle');
  const [waitUntil, setWaitUntil] = useState(() => (sentAt ? sentAt + RESEND_COOLDOWN_MS : 0));
  const [now, setNow] = useState(() => Date.now());
  const waiting = waitUntil > now;

  // One re-render when the wait ends, not a ticking countdown that a screen
  // reader would announce every second.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setNow(Date.now()), waitUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [waiting, waitUntil]);

  async function resend() {
    if (!email.trim() || state === 'sending' || waiting) return;
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
        className="w-full"
        disabled={!email.trim() || state === 'sending' || waiting}
        aria-describedby={waiting ? 'resend-wait' : undefined}
        onClick={() => void resend()}
      >
        {state === 'sending' ? 'Requesting email...' : 'Resend verification email'}
      </Button>
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

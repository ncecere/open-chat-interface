import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';

/** Delivery can recover without recreating the account or reusing an invitation. */
export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'requested' | 'error'>('idle');

  async function resend() {
    if (!email.trim() || state === 'sending') return;
    setState('sending');
    try {
      const result = await authClient.sendVerificationEmail({
        email: email.trim(),
        callbackURL: '/',
      });
      setState(result.error ? 'error' : 'requested');
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
        disabled={!email.trim() || state === 'sending'}
        onClick={() => void resend()}
      >
        {state === 'sending' ? 'Requesting email...' : 'Resend verification email'}
      </Button>
      {state === 'requested' && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          If this address needs verification, check its inbox. If no email arrives, try again later
          or contact an administrator to check email delivery.
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-xs text-[var(--danger-foreground)]">
          Could not request a verification email. Try again later or contact an administrator.
        </p>
      )}
    </div>
  );
}

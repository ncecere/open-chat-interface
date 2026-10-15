import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fingerprint } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { authClient } from '~/lib/auth-client';
import { answered } from '~/lib/auth-unavailable';
import { type PasskeyProblem, passkeyProblem, webAuthnSupported } from '~/lib/mfa';
import { failureOf, retryAfterCapture } from '~/lib/second-step';

/**
 * What every successful sign-in does next: drop anything cached while signed
 * out (an anonymous /me answer would otherwise be reused for the new account),
 * then go to the page the person asked for.
 */
export function useFinishSignIn(returnTo: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    queryClient.clear();
    await navigate({ href: returnTo });
  };
}

/**
 * Sign in with a passkey, on the sign-in page and as the alternative on the
 * second step. A passkey is both factors (the server refuses one that was not
 * used with a PIN or biometric), so there is no code afterwards. Its label is
 * "Use a passkey", not "Sign in with a passkey": every browser test finds the
 * password button by the name "Sign in", which matches by substring. Not shown
 * where the browser has no WebAuthn; the person closing the browser's prompt is
 * said calmly, not as an error.
 */
export function PasskeySignInButton({
  returnTo,
  label = 'Use a passkey',
  variant = 'secondary',
  className,
}: {
  returnTo: string;
  label?: string;
  variant?: 'secondary' | 'ghost' | 'link';
  className?: string;
}) {
  const finish = useFinishSignIn(returnTo);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<PasskeyProblem | null>(null);
  if (!webAuthnSupported()) return null;

  async function signIn() {
    setProblem(null);
    setPending(true);
    const { captured, fetchOptions } = retryAfterCapture();
    const result = await answered(authClient.signIn.passkey({ fetchOptions }));
    if (result.error) {
      setProblem(passkeyProblem(failureOf(result.error, captured.seconds)));
      setPending(false);
      return;
    }
    await finish();
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant={variant}
        className="w-full"
        disabled={pending}
        aria-describedby={problem ? 'passkey-sign-in-message' : undefined}
        onClick={signIn}
      >
        {pending ? <Spinner /> : <Fingerprint />}
        {label}
      </Button>
      {problem && (
        <p
          id="passkey-sign-in-message"
          role={problem.kind === 'error' ? 'alert' : 'status'}
          className={
            problem.kind === 'error'
              ? 'mt-2 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]'
              : 'mt-2 text-xs text-[var(--text-muted)]'
          }
        >
          {problem.text}
        </p>
      )}
    </div>
  );
}

/**
 * Conditional UI: the browser offers the person's passkeys in the email field's
 * autofill list, so one can be chosen without pressing a button. Only where the
 * browser supports it; the field then carries the `webauthn` autofill token (the
 * return value says so). The request stays pending until a passkey is chosen or
 * another WebAuthn request replaces it (the button's), which ends this one with
 * an abort that is not an error here: only a completed sign-in is acted on.
 */
export function usePasskeyAutofill(returnTo: string, enabled: boolean): boolean {
  const [available, setAvailable] = useState(false);
  const finish = useFinishSignIn(returnTo);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (!enabled || !webAuthnSupported()) return;
    let current = true;
    void (async () => {
      const conditional = await Promise.resolve(
        window.PublicKeyCredential.isConditionalMediationAvailable?.(),
      ).catch(() => false);
      if (!conditional || !current) return;
      // The field must carry the token before the request is made.
      setAvailable(true);
      const result = await answered(authClient.signIn.passkey({ autoFill: true }));
      if (current && !result.error && result.data) await finishRef.current();
    })();
    return () => {
      current = false;
    };
  }, [enabled]);

  return available;
}

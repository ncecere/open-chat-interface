import { instanceName } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthFormError, authFieldProps, useFocusAfterRender } from '~/components/auth/form-error';
import { PasskeySignInButton, useFinishSignIn } from '~/components/auth/passkey-sign-in';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import type { SecondStepProblem } from '~/lib/mfa';
import { returnPathFromSearch, signInSearch } from '~/lib/return-path';
import { verifySecondStep } from '~/lib/second-step';

type Method = 'totp' | 'recovery';

const COPY: Record<Method, { label: string; hint: string; empty: string }> = {
  totp: {
    label: 'Authentication code',
    hint: 'The 6-digit code from your authenticator app. You can paste it; spaces are fine.',
    empty: 'Enter the code from your authenticator app.',
  },
  recovery: {
    label: 'Recovery code',
    hint: 'One of the recovery codes you saved when you set up two-step verification. Each works once. You can paste it.',
    empty: 'Enter one of your recovery codes.',
  },
};

/**
 * The second step of a password sign-in (#399).
 *
 * One field, not a box per digit: a paste, a password manager and a screen
 * reader all work with one (WCAG 2.2 SC 3.3.8, accessible authentication).
 * Nothing is sent until Verify is pressed. The challenge the password step
 * started lives in a cookie for ten minutes; once it has ended (it expired, or
 * five wrong codes) the page offers to start again rather than another try.
 */
export function TwoFactorPage() {
  const { data: status } = useAuthStatus();
  // The page a signed-out visit asked for (#225), kept through the password step.
  const [returnTo] = useState(() => returnPathFromSearch() ?? '/');
  const finish = useFinishSignIn(returnTo);
  const focusAfterRender = useFocusAfterRender();
  const [method, setMethod] = useState<Method>('totp');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<SecondStepProblem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const copy = COPY[method];
  // Back to sign-in, which asks for the password again and comes back here.
  const signInAgain = signInSearch(returnTo);

  function change(next: string) {
    setCode(next);
    setProblem(null);
  }

  function switchMethod(next: Method) {
    setMethod(next);
    setCode('');
    setProblem(null);
    focusAfterRender('two-factor-code');
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!code.trim()) {
      setProblem({ text: copy.empty, endsChallenge: false });
      focusAfterRender('two-factor-code');
      return;
    }
    setSubmitting(true);
    const result = await verifySecondStep(method, code);
    if (!result.ok) {
      setProblem(result.problem);
      focusAfterRender(result.problem.endsChallenge ? 'two-factor-start-again' : 'two-factor-code');
      setSubmitting(false);
      return;
    }
    await finish();
  }

  const appName = status?.branding?.appName;
  const ended = problem?.endsChallenge === true;

  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pt-[12vh] pb-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark
            name={appName}
            shortName={status?.branding?.shortName}
            logoUrl={status?.branding?.logoUrl}
            className="text-2xl"
          />
        </div>

        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
          <h1 className="text-lg font-semibold">Two-step verification</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {ended
              ? `Sign in to ${instanceName(appName)} again to get a new attempt.`
              : method === 'totp'
                ? 'Enter the code from your authenticator app to finish signing in.'
                : 'Enter one of your recovery codes to finish signing in.'}
          </p>

          {ended ? (
            <div className="mt-5 flex flex-col gap-4">
              <AuthFormError id="two-factor-error">{problem.text}</AuthFormError>
              <Button id="two-factor-start-again" variant="primary" className="w-full" asChild>
                <Link to="/auth/login" search={signInAgain as never}>
                  Start again
                </Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4" noValidate>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="two-factor-code">{copy.label}</Label>
                <Input
                  id="two-factor-code"
                  {...authFieldProps({
                    errorId: 'two-factor-error',
                    error: problem?.text ?? null,
                    fieldId: 'two-factor-code',
                    invalid: Boolean(problem),
                    hintId: 'two-factor-hint',
                  })}
                  // Recovery codes are case-sensitive text; an authenticator code is digits.
                  type="text"
                  inputMode={method === 'totp' ? 'numeric' : 'text'}
                  autoComplete={method === 'totp' ? 'one-time-code' : 'off'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  // Auto-focus is the one thing wanted on arrival: the field is the page.
                  autoFocus
                  value={code}
                  onChange={(event) => change(event.target.value)}
                />
                <p id="two-factor-hint" className="text-xs text-[var(--text-muted)]">
                  {copy.hint}
                </p>
              </div>

              {problem && <AuthFormError id="two-factor-error">{problem.text}</AuthFormError>}

              <Button
                id="two-factor-submit"
                type="submit"
                variant="primary"
                disabled={submitting}
                className="w-full"
              >
                {submitting ? <Spinner className="text-white" /> : <ShieldCheck />}
                Verify
              </Button>

              <div className="flex flex-col items-center gap-1">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => switchMethod(method === 'totp' ? 'recovery' : 'totp')}
                >
                  {method === 'totp'
                    ? 'Use a recovery code instead'
                    : 'Use an authenticator code instead'}
                </Button>
                <PasskeySignInButton
                  returnTo={returnTo}
                  label="Use a passkey instead"
                  variant="link"
                />
              </div>
            </form>
          )}
        </div>

        {!ended && (
          <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
            <Link
              to="/auth/login"
              search={signInAgain as never}
              className="hover:text-[var(--text-primary)]"
            >
              Back to sign in
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

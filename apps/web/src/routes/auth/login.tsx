import { instanceName } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  AuthFormError,
  authFormProblems,
  emailProblem,
  fieldErrorProps,
  useFocusAfterRender,
} from '~/components/auth/form-error';
import { ResendVerification } from '~/components/auth/resend-verification';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';
import { answered, isServiceFailure, SIGN_IN_UNAVAILABLE } from '~/lib/auth-unavailable';
import { returnPathFromSearch } from '~/lib/return-path';
import { SIGNED_OUT_PARAM } from '~/lib/session-ended';

const WRONG_CREDENTIALS = 'Unable to sign in. Check your email and password.';

/**
 * Where the SSO plugin sends a refused sign-in (no matching role, a provider
 * not trusted to link to an existing account, a failed discovery). Without it
 * the refusal went to the callback URL, `/`, whose guard redirects a signed-out
 * visitor here and drops the query, so the reason was never shown.
 */
const SSO_ERROR_URL = '/auth/login';

const ACCOUNT_EXISTS =
  'An account with this email address already exists. Sign in the way you usually do; this identity provider is not trusted to sign in to existing accounts. An administrator can change that under Single sign-on.';

/** Better Auth's error codes for a refused SSO sign-in, which are not sentences. */
const SSO_ERROR_TEXT: Record<string, string> = {
  'account not linked': ACCOUNT_EXISTS,
  'unable to link account': ACCOUNT_EXISTS,
  ACCOUNT_NOT_LINKED: ACCOUNT_EXISTS,
};

/** A correct password for an address not yet verified (#330). */
export function unverifiedMessage(email: string, canSendEmail: boolean): string {
  return canSendEmail
    ? `Your email address is not verified yet. A verification link is on its way to ${email}: open it to finish signing in. It can take a few minutes, so check your spam folder too.`
    : 'Your email address is not verified yet, and this service cannot send email right now. Ask an administrator.';
}

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Only the first load waits: a 5 s re-check during an outage keeps the form
  // (it was swapped for a spinner, typing and all, #307).
  const { data: status, firstLoad } = useAuthStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // When a refused sign-in for an unverified address sent a new link (#330).
  const [verificationSentAt, setVerificationSentAt] = useState<number | null>(null);
  const needsVerification = verificationSentAt !== null;
  const focusAfterRender = useFocusAfterRender();
  // Only wrong credentials are about the fields; a rate limit is not (#183).
  const invalidCredentials = error === WRONG_CREDENTIALS;
  // The fields the form's own check found empty or malformed (#320's sweep).
  const [missing, setMissing] = useState<string[]>([]);
  // Sent here because the session ended while the app was open (#165).
  const [signedOut] = useState(() =>
    new URLSearchParams(window.location.search).has(SIGNED_OUT_PARAM),
  );
  // The page a signed-out visit asked for, to return to afterwards (#225);
  // only a path on this site, so the parameter cannot send anyone elsewhere.
  const [returnTo] = useState(() => returnPathFromSearch() ?? '/');

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setVerificationSentAt(null);
    const problems = authFormProblems([
      { id: 'email', problem: emailProblem(email) },
      { id: 'password', problem: password ? null : 'Enter your password.' },
    ]);
    setMissing(problems?.ids ?? []);
    if (problems) {
      setError(problems.message);
      focusAfterRender(problems.ids[0]!);
      return;
    }
    setSubmitting(true);

    const result = await answered(authClient.signIn.email({ email, password }));

    if (result.error) {
      const unverified = result.error.code === 'EMAIL_NOT_VERIFIED';
      setVerificationSentAt(unverified ? Date.now() : null);
      if (unverified) {
        // Only after the right password, so it says nothing about who has an
        // account. The bare "Email not verified" sent people to Resend for a
        // duplicate of the link this sign-in had just sent (#330).
        setError(unverifiedMessage(email.trim(), status?.smtpConfigured !== false));
        focusAfterRender('login-submit');
        setSubmitting(false);
        return;
      }
      // The service failing (its database unreachable, the API restarting) is
      // not the person's doing, so it is not worded as a wrong password (#288).
      const failed = isServiceFailure(result.error);
      // Wrong credentials get the wording the user guide quotes (#97); other
      // refusals (unverified, banned, rate limited) keep the server's reason.
      const wrong =
        !failed && (result.error.code === 'INVALID_EMAIL_OR_PASSWORD' || !result.error.message);
      setError(failed ? SIGN_IN_UNAVAILABLE : wrong ? WRONG_CREDENTIALS : result.error.message!);
      // Back to the form rather than the body (#190): the fields at fault, which
      // the error describes, or the button for a refusal that is not theirs.
      focusAfterRender(wrong ? 'email' : 'login-submit');
      setSubmitting(false);
      return;
    }

    // Drop anything cached while signed out (or for whoever signed out in
    // this tab): an anonymous /me answer would otherwise be reused for the
    // new account, hiding its menu, projects and features until a reload.
    queryClient.clear();
    await navigate({ href: returnTo });
  }

  async function handleSso(providerId: string) {
    setError(null);
    await authClient.signIn.sso({
      providerId,
      callbackURL: returnTo,
      errorCallbackURL: SSO_ERROR_URL,
    });
  }

  /**
   * Surfaces a refusal carried back from the identity provider round trip.
   *
   * A sign-in refused for want of a role fails after authentication succeeded,
   * so without this the page would look like an outage rather than a decision
   * somebody configured.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const description = params.get('error_description');
    const code = params.get('error');
    if (!description && !code) return;

    setError(
      (code && SSO_ERROR_TEXT[code]) ||
        description ||
        'Your account is not authorised to use this application.',
    );
  }, []);

  /**
   * Sends straight to a provider configured to skip this page.
   *
   * `?local=1` suppresses it. Without that escape hatch a broken provider
   * would make the instance unreachable, since every visit would bounce
   * to it and there would be no way to reach the local form.
   *
   * A refusal message means the redirect has already happened and come back;
   * bouncing again would loop.
   */
  useEffect(() => {
    // After being signed out, say so rather than sign straight back in.
    if (!status || error || signedOut) return;
    if (new URLSearchParams(window.location.search).has('local')) return;

    const auto = status.ssoProviders.find((provider) => provider.autoRedirect);
    // Called directly rather than through handleSso, which is rebuilt on every
    // render and would re-run this effect each time.
    if (auto)
      void authClient.signIn.sso({
        providerId: auto.providerId,
        callbackURL: returnTo,
        errorCallbackURL: SSO_ERROR_URL,
      });
  }, [status, error, signedOut, returnTo]);

  const appName = status?.branding.appName;

  return (
    // The page's main landmark, as on every other auth page (#173).
    <main className="flex min-h-dvh flex-col items-center px-4 pt-[12vh] pb-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {/* The page's heading; the wordmark beside it is an image of the name (#110). */}
          <h1 className="sr-only">Sign in to {instanceName(appName)}</h1>
          <Wordmark
            name={appName}
            shortName={status?.branding.shortName}
            logoUrl={status?.branding.logoUrl}
            className="text-2xl"
          />
          <p className="text-sm text-[var(--text-muted)]">
            {status?.branding.loginMessage ?? 'Sign in to continue to your conversations.'}
          </p>
        </div>

        {firstLoad ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              {signedOut && !error && (
                <p
                  role="status"
                  className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-secondary)]"
                >
                  You were signed out, from another device or by an administrator. Sign in again to
                  continue.
                </p>
              )}
              {/* Only when known: a status that failed to load (#288) is not a setting. */}
              {status && !status.localAuthEnabled && (
                // The form stays usable because administrators still need a way
                // in when an identity provider is misconfigured. Saying so
                // plainly avoids the form looking simply broken to everyone else.
                <p className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
                  Use one of the sign-in options above. Password sign-in is turned off for this
                  instance and is kept only so administrators can recover access.
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  {...fieldErrorProps(
                    'login-error',
                    error,
                    invalidCredentials || missing.includes('email'),
                  )}
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  {...fieldErrorProps(
                    'login-error',
                    error,
                    invalidCredentials || missing.includes('password'),
                  )}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {error && <AuthFormError id="login-error">{error}</AuthFormError>}

              <Button
                id="login-submit"
                type="submit"
                variant="primary"
                disabled={submitting}
                className="mt-1 w-full"
              >
                {submitting ? <Spinner className="text-white" /> : <KeyRound />}
                Sign in
              </Button>
              {needsVerification && status?.smtpConfigured !== false && (
                <ResendVerification
                  key={email}
                  email={email}
                  sentAt={verificationSentAt ?? undefined}
                />
              )}
              {status?.localAuthEnabled && status.smtpConfigured && (
                <Link
                  to="/auth/forgot-password"
                  className="text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Forgot your password?
                </Link>
              )}
            </form>

            {status && status.ssoProviders.length > 0 && (
              <>
                <div className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                  <span className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)]">
                    or
                  </span>
                  <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                </div>

                <div className="flex flex-col gap-2">
                  {status.ssoProviders.map((provider) => (
                    <Button
                      key={provider.providerId}
                      variant="secondary"
                      className="w-full"
                      onClick={() => handleSso(provider.providerId)}
                    >
                      <ShieldCheck />
                      Continue with {provider.label}
                    </Button>
                  ))}
                </div>
              </>
            )}

            {status?.registrationMode === 'open' && status.localAuthEnabled && (
              <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
                New here?{' '}
                <Link
                  to="/auth/signup"
                  className="font-medium text-[var(--accent-bright)] hover:underline"
                >
                  Create an account
                </Link>
              </p>
            )}

            {status?.registrationMode === 'invite_only' && (
              <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
                This instance is invite only. Ask an administrator for an invitation link.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

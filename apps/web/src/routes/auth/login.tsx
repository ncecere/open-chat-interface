import { instanceName, MFA_CHALLENGE_PATH } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { bdiMessage } from '~/components/auth/bdi-message';
import {
  AuthFormError,
  authFieldProps,
  authFormProblems,
  emailProblem,
  type FieldMessage,
  useFocusAfterRender,
} from '~/components/auth/form-error';
import { PasskeySignInButton, usePasskeyAutofill } from '~/components/auth/passkey-sign-in';
import { ResendVerification } from '~/components/auth/resend-verification';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';
import { answered, isServiceFailure, signInUnavailable } from '~/lib/auth-unavailable';
import { translate, useT } from '~/lib/i18n';
import { returnPathFromSearch, signInSearch } from '~/lib/return-path';
import { SIGNED_OUT_PARAM } from '~/lib/session-ended';

/**
 * Where the SSO plugin sends a refused sign-in (no matching role, a provider
 * not trusted to link to an existing account, a failed discovery). Without it
 * the refusal went to the callback URL, `/`, whose guard redirects a signed-out
 * visitor here and drops the query, so the reason was never shown.
 */
const SSO_ERROR_URL = '/auth/login';

/** Better Auth's error codes for a refused SSO sign-in, which are not sentences. */
const SSO_ERROR_CODES = new Set([
  'account not linked',
  'unable to link account',
  'ACCOUNT_NOT_LINKED',
]);

export function LoginPage() {
  const t = useT();
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
  // The address a verification link went to, shown inside the error's sentence.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const needsVerification = verificationSentAt !== null;
  const focusAfterRender = useFocusAfterRender();
  // Only wrong credentials are about the fields; a rate limit is not (#183).
  const invalidCredentials = error === t('auth.login.wrongCredentials');
  // The fields the form's own check found empty or malformed (#320's sweep).
  const [messages, setMessages] = useState<FieldMessage[]>([]);
  const missing = messages.map((message) => message.id);
  // Sent here because the session ended while the app was open (#165).
  const [signedOut] = useState(() =>
    new URLSearchParams(window.location.search).has(SIGNED_OUT_PARAM),
  );
  // The page a signed-out visit asked for, to return to afterwards (#225);
  // only a path on this site, so the parameter cannot send anyone elsewhere.
  const [returnTo] = useState(() => returnPathFromSearch() ?? '/');
  // The browser may offer the person's passkeys in the email field (#399).
  const passkeyAutofill = usePasskeyAutofill(returnTo, !firstLoad);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setVerificationSentAt(null);
    setUnverifiedEmail(null);
    const problems = authFormProblems([
      { id: 'email', problem: emailProblem(email) },
      { id: 'password', problem: password ? null : t('auth.form.passwordRequired') },
    ]);
    setMessages(problems?.messages ?? []);
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
        const canSendEmail = status?.smtpConfigured !== false;
        setUnverifiedEmail(canSendEmail ? email.trim() : null);
        setError(
          canSendEmail
            ? t('auth.login.unverifiedSent', { email: email.trim() })
            : t('auth.login.unverifiedNoMail'),
        );
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
      setError(
        failed
          ? signInUnavailable()
          : wrong
            ? t('auth.login.wrongCredentials')
            : result.error.message!,
      );
      // Back to the form rather than the body (#190): the fields at fault, which
      // the error describes, or the button for a refusal that is not theirs.
      focusAfterRender(wrong ? 'email' : 'login-submit');
      setSubmitting(false);
      return;
    }

    // The right password for a person with a second step: no session yet, the
    // code is asked for on its own page, which comes back to `returnTo` (#399).
    if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
      await navigate({ to: MFA_CHALLENGE_PATH, search: signInSearch(returnTo) as never });
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
      (code && SSO_ERROR_CODES.has(code) && translate('auth.login.accountExists')) ||
        description ||
        translate('auth.login.notAuthorised'),
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
          <h1 className="sr-only">{t('auth.login.heading', { appName: instanceName(appName) })}</h1>
          <Wordmark
            name={appName}
            shortName={status?.branding.shortName}
            logoUrl={status?.branding.logoUrl}
            className="text-2xl"
          />
          <p className="text-sm text-[var(--text-muted)]">
            {status?.branding.loginMessage ?? t('auth.login.subtitle')}
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
                  {t('auth.login.signedOut')}
                </p>
              )}
              {/* Only when known: a status that failed to load (#288) is not a setting. */}
              {status && !status.localAuthEnabled && (
                // The form stays usable because administrators still need a way
                // in when an identity provider is misconfigured. Saying so
                // plainly avoids the form looking simply broken to everyone else.
                <p className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
                  {t('auth.login.passwordOff')}
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">{t('auth.common.email')}</Label>
                <Input
                  id="email"
                  {...authFieldProps({
                    errorId: 'login-error',
                    error,
                    messages,
                    fieldId: 'email',
                    invalid: invalidCredentials || missing.includes('email'),
                  })}
                  type="email"
                  autoComplete={passkeyAutofill ? 'email webauthn' : 'email'}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={t('auth.common.emailPlaceholder')}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">{t('auth.common.password')}</Label>
                <Input
                  id="password"
                  {...authFieldProps({
                    errorId: 'login-error',
                    error,
                    messages,
                    fieldId: 'password',
                    invalid: invalidCredentials || missing.includes('password'),
                  })}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {error && (
                <AuthFormError id="login-error" messages={messages}>
                  {unverifiedEmail
                    ? bdiMessage(t, 'auth.login.unverifiedSent', undefined, {
                        email: unverifiedEmail,
                      })
                    : error}
                </AuthFormError>
              )}

              <Button
                id="login-submit"
                type="submit"
                variant="primary"
                disabled={submitting}
                className="mt-1 w-full"
              >
                {submitting ? <Spinner className="text-white" /> : <KeyRound />}
                {t('auth.common.signIn')}
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
                  {t('auth.login.forgotPassword')}
                </Link>
              )}
            </form>

            {/* Not shown where the browser has no WebAuthn. */}
            <PasskeySignInButton returnTo={returnTo} className="mt-3" />

            {status && status.ssoProviders.length > 0 && (
              <>
                <div className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                  <span className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)]">
                    {t('auth.login.or')}
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
                      {t('auth.login.continueWith', { provider: provider.label })}
                    </Button>
                  ))}
                </div>
              </>
            )}

            {status?.registrationMode === 'open' && status.localAuthEnabled && (
              <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
                {t('auth.login.newHere')}{' '}
                <Link
                  to="/auth/signup"
                  className="font-medium text-[var(--accent-bright)] hover:underline"
                >
                  {t('auth.login.createAccount')}
                </Link>
              </p>
            )}

            {status?.registrationMode === 'invite_only' && (
              <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
                {t('auth.login.inviteOnly')}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

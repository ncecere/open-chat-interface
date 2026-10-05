import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ResendVerification } from '~/components/auth/resend-verification';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';

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

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useAuthStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNeedsVerification(false);
    setSubmitting(true);

    const result = await authClient.signIn.email({ email, password });

    if (result.error) {
      setNeedsVerification(result.error.code === 'EMAIL_NOT_VERIFIED');
      // Wrong credentials get the wording the user guide quotes (#97); other
      // refusals (unverified, banned, rate limited) keep the server's reason.
      setError(
        result.error.code === 'INVALID_EMAIL_OR_PASSWORD' || !result.error.message
          ? WRONG_CREDENTIALS
          : result.error.message,
      );
      setSubmitting(false);
      return;
    }

    // Drop anything cached while signed out (or for whoever signed out in
    // this tab): an anonymous /me answer would otherwise be reused for the
    // new account, hiding its menu, projects and features until a reload.
    queryClient.clear();
    await navigate({ to: '/' });
  }

  async function handleSso(providerId: string) {
    setError(null);
    await authClient.signIn.sso({ providerId, callbackURL: '/', errorCallbackURL: SSO_ERROR_URL });
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
    if (!status || error) return;
    if (new URLSearchParams(window.location.search).has('local')) return;

    const auto = status.ssoProviders.find((provider) => provider.autoRedirect);
    // Called directly rather than through handleSso, which is rebuilt on every
    // render and would re-run this effect each time.
    if (auto)
      void authClient.signIn.sso({
        providerId: auto.providerId,
        callbackURL: '/',
        errorCallbackURL: SSO_ERROR_URL,
      });
  }, [status, error]);

  const appName = status?.branding.appName;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
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

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-5" />
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {!status?.localAuthEnabled && (
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
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••••••"
                />
              </div>

              {error && (
                <p className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]">
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" disabled={submitting} className="mt-1 w-full">
                {submitting ? <Spinner className="text-white" /> : <KeyRound />}
                Sign in
              </Button>
              {needsVerification && <ResendVerification key={email} email={email} />}
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
    </div>
  );
}

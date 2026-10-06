import { Link } from '@tanstack/react-router';
import { CheckCircle2, KeyRound, Lock, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  AuthFormError,
  AuthOutcomeHeading,
  emailProblem,
  fieldErrorProps,
  newPasswordProblem,
  useFocusAfterRender,
} from '~/components/auth/form-error';
import { AuthStatusUnavailable } from '~/components/auth/status-unavailable';
import { Wordmark } from '~/components/brand/wordmark';
import { useReadOnlyPolling } from '~/components/layout/read-only-banner';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';
import { answered, isServiceFailure, PASSWORD_RESET_UNAVAILABLE } from '~/lib/auth-unavailable';
import { authReadOnlyRefusal, passwordResetPausedMessage } from '~/lib/read-only';

/**
 * The auth pages' frame: the same distance from the top on every page (they
 * were centred, so each sat at its own height), and a subtitle under the
 * wordmark as on sign-in (#112).
 */
function AuthCard({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  const { data: status } = useAuthStatus();
  return (
    <main className="flex min-h-dvh justify-center px-4 pt-[12vh] pb-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark
            name={status?.branding.appName}
            shortName={status?.branding?.shortName}
            logoUrl={status?.branding?.logoUrl}
            className="text-2xl"
          />
          {subtitle && <p className="text-sm text-[var(--text-muted)]">{subtitle}</p>}
        </div>
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
          {children}
        </div>
      </div>
    </main>
  );
}

export function ForgotPasswordPage() {
  const { data: status, unavailable, refetch } = useAuthStatus();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a submit has replaced the form, whose heading then takes focus (#190).
  const [submitted, setSubmitted] = useState(false);
  const focusAfterRender = useFocusAfterRender();
  // Read-only maintenance refuses resets (#138): say so before and after a
  // send. The status is public, like the banner's.
  const readOnly = useReadOnlyPolling();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // The app's own words, not the browser's bubble (#320's sweep).
    const problem = emailProblem(email);
    if (problem) {
      setError(problem);
      focusAfterRender('reset-email');
      return;
    }
    setSubmitting(true);
    const result = await answered(
      authClient.requestPasswordReset({ email, redirectTo: '/auth/reset-password' }),
    );
    setSubmitting(false);
    setSubmitted(true);
    // A refusal (read-only, rate limit, server error) does not depend on
    // whether the account exists, so it can be shown. Read-only switches the
    // page to the paused state through the store.
    if (result.error) {
      if (!authReadOnlyRefusal(result.error)) {
        setError(
          isServiceFailure(result.error)
            ? PASSWORD_RESET_UNAVAILABLE
            : result.error.message || 'The reset link could not be sent. Try again.',
        );
        // The form stays: back to its button rather than the body (#190).
        focusAfterRender('reset-request-submit');
      }
      return;
    }
    // The same result whether or not an account exists, to avoid disclosing it.
    setSent(true);
  }

  const available = Boolean(status?.localAuthEnabled && status.smtpConfigured);
  const paused = available && !sent && readOnly.active;
  const offered = available && !sent && !paused;
  return (
    <AuthCard subtitle={offered ? 'We will email you a secure reset link.' : undefined}>
      {paused ? (
        <div className="space-y-4 text-center">
          <Lock className="mx-auto size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <AuthOutcomeHeading focus={submitted} describedBy="reset-paused-message">
            Password reset paused
          </AuthOutcomeHeading>
          <p id="reset-paused-message" role="status" className="text-sm text-[var(--text-muted)]">
            {passwordResetPausedMessage(readOnly)}
          </p>
          <Button asChild className="w-full">
            <Link to="/auth/login">Return to sign in</Link>
          </Button>
        </div>
      ) : sent ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-9 text-[var(--accent-bright)]" />
          <AuthOutcomeHeading focus={submitted} describedBy="reset-sent-message">
            Check your email
          </AuthOutcomeHeading>
          <p id="reset-sent-message" className="text-sm text-[var(--text-muted)]">
            If an account exists, a password reset link has been sent.
          </p>
          <Button asChild className="w-full">
            <Link to="/auth/login">Return to sign in</Link>
          </Button>
        </div>
      ) : unavailable ? (
        // The status could not be loaded: an outage, not a sign that resets
        // are not offered (#288). It stays up while each 5 s check is out (#307).
        <AuthStatusUnavailable title="Password reset temporarily unavailable" refetch={refetch} />
      ) : !status ? (
        // The first load: neither the form nor "unavailable" yet (#288).
        <div className="flex justify-center py-8">
          <Spinner className="size-5" />
        </div>
      ) : !status.localAuthEnabled || !status.smtpConfigured ? (
        <div className="space-y-4 text-center">
          <h1 className="text-lg font-semibold">Password reset unavailable</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Contact an administrator for account recovery.
          </p>
          <Button asChild className="w-full">
            <Link to="/auth/login">Return to sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="text-center">
            <h1 className="text-lg font-semibold">Reset your password</h1>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-email">Email</Label>
            <Input
              id="reset-email"
              {...fieldErrorProps('reset-request-error', error, error === emailProblem(email))}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          {error && <AuthFormError id="reset-request-error">{error}</AuthFormError>}
          <Button
            id="reset-request-submit"
            type="submit"
            variant="primary"
            disabled={submitting}
            className="w-full"
          >
            {submitting ? <Spinner /> : <Mail />} Send reset link
          </Button>
          <Link
            to="/auth/login"
            className="text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Return to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  // The emailed link checks its token first and comes back with ?error= when
  // it is invalid or expired; a token that fails on submit says the same (#112).
  const [invalid, setInvalid] = useState(
    () => new URLSearchParams(window.location.search).get('error') === 'INVALID_TOKEN',
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  // Whether a submit has replaced the form, whose heading then takes focus (#190).
  const [submitted, setSubmitted] = useState(false);
  const focusAfterRender = useFocusAfterRender();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const problem = newPasswordProblem(password);
    if (problem) {
      setError(problem);
      focusAfterRender('new-password');
      return;
    }
    setSubmitting(true);
    const result = await answered(authClient.resetPassword({ newPassword: password, token }));
    setSubmitted(true);
    if (result.error) {
      if (result.error.code === 'INVALID_TOKEN') {
        setInvalid(true);
        setSubmitting(false);
        return;
      }
      // An outage is not the link's fault (#288): the link still works afterwards.
      setError(
        isServiceFailure(result.error)
          ? PASSWORD_RESET_UNAVAILABLE
          : (result.error.message ?? 'This reset link is invalid or expired.'),
      );
      // Back to the field the error describes rather than the body (#190).
      focusAfterRender('new-password');
      setSubmitting(false);
      return;
    }
    setComplete(true);
    setSubmitting(false);
  }

  return (
    <AuthCard>
      {complete ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-9 text-[var(--accent-bright)]" />
          <AuthOutcomeHeading focus={submitted}>Password updated</AuthOutcomeHeading>
          <Button asChild variant="primary" className="w-full">
            <Link to="/auth/login">Continue to sign in</Link>
          </Button>
        </div>
      ) : invalid || !token ? (
        <div className="space-y-4 text-center">
          <AuthOutcomeHeading focus={submitted} describedBy="reset-unavailable-message">
            Reset link unavailable
          </AuthOutcomeHeading>
          <p id="reset-unavailable-message" className="text-sm text-[var(--text-muted)]">
            {invalid
              ? 'This reset link is invalid or has expired.'
              : 'This link is missing its reset token.'}
          </p>
          <Button asChild className="w-full">
            <Link to="/auth/forgot-password">Request a new link</Link>
          </Button>
          <Link
            to="/auth/login"
            className="block text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Return to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="text-center">
            <h1 className="text-lg font-semibold">Choose a new password</h1>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              {...fieldErrorProps('new-password-error', error, Boolean(error), 'new-password-hint')}
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p id="new-password-hint" className="text-xs text-[var(--text-muted)]">
              Use at least 12 characters.
            </p>
          </div>
          {error && <AuthFormError id="new-password-error">{error}</AuthFormError>}
          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
            {submitting ? <Spinner /> : <KeyRound />} Update password
          </Button>
          <Link
            to="/auth/login"
            className="text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Return to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}

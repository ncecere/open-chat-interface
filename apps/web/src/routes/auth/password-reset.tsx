import { Link } from '@tanstack/react-router';
import { CheckCircle2, KeyRound, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';

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
  const { data: status } = useAuthStatus();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    await authClient.requestPasswordReset({ email, redirectTo: '/auth/reset-password' });
    // Always use the same result to avoid disclosing whether an account exists.
    setSent(true);
    setSubmitting(false);
  }

  const offered = !sent && Boolean(status?.localAuthEnabled && status.smtpConfigured);
  return (
    <AuthCard subtitle={offered ? 'We will email you a secure reset link.' : undefined}>
      {sent ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-9 text-[var(--accent-bright)]" />
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p className="text-sm text-[var(--text-muted)]">
            If an account exists, a password reset link has been sent.
          </p>
          <Button asChild className="w-full">
            <Link to="/auth/login">Return to sign in</Link>
          </Button>
        </div>
      ) : !status?.localAuthEnabled || !status.smtpConfigured ? (
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="text-center">
            <h1 className="text-lg font-semibold">Reset your password</h1>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reset-email">Email</Label>
            <Input
              id="reset-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) {
      if (result.error.code === 'INVALID_TOKEN') {
        setInvalid(true);
        setSubmitting(false);
        return;
      }
      setError(result.error.message ?? 'This reset link is invalid or expired.');
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
          <h1 className="text-lg font-semibold">Password updated</h1>
          <Button asChild variant="primary" className="w-full">
            <Link to="/auth/login">Continue to sign in</Link>
          </Button>
        </div>
      ) : invalid || !token ? (
        <div className="space-y-4 text-center">
          <h1 className="text-lg font-semibold">Reset link unavailable</h1>
          <p className="text-sm text-[var(--text-muted)]">
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
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="text-center">
            <h1 className="text-lg font-semibold">Choose a new password</h1>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-[var(--text-muted)]">Use at least 12 characters.</p>
          </div>
          {error && (
            <p className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]">
              {error}
            </p>
          )}
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

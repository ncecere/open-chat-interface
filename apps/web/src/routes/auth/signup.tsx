import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2, UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthFormError, fieldErrorProps } from '~/components/auth/form-error';
import { ResendVerification } from '~/components/auth/resend-verification';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';

export function SignupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useAuthStatus();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  const registrationAvailable = status?.localAuthEnabled && status.registrationMode === 'open';

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await authClient.signUp.email({ name, email, password });
    if (result.error) {
      setError(result.error.message ?? 'Unable to create your account.');
      setSubmitting(false);
      return;
    }

    // The server's current policy wins over possibly stale bootstrap settings.
    if (!result.data?.token) {
      setCreated(true);
      setSubmitting(false);
      return;
    }
    // As on sign-in: nothing cached while signed out may describe the new account.
    queryClient.clear();
    await navigate({ to: '/' });
  }

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
          <p className="text-sm text-[var(--text-muted)]">Create your account.</p>
        </div>

        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="size-5" />
            </div>
          ) : created ? (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto size-9 text-[var(--accent-bright)]" />
              <h1 className="text-lg font-semibold">Check your email</h1>
              <p className="text-sm text-[var(--text-muted)]">
                Follow the verification link before signing in. If it does not arrive, you can
                request another email below.
              </p>
              <ResendVerification email={email} />
              <Button asChild variant="primary" className="w-full">
                <Link to="/auth/login">Return to sign in</Link>
              </Button>
            </div>
          ) : !registrationAvailable ? (
            <div className="space-y-4 text-center">
              <h1 className="text-lg font-semibold">Registration unavailable</h1>
              <p className="text-sm text-[var(--text-muted)]">
                This instance is not accepting open account registrations.
              </p>
              <Button asChild className="w-full">
                <Link to="/auth/login">Return to sign in</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-name">Name</Label>
                <Input
                  id="signup-name"
                  autoComplete="name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  {...fieldErrorProps('signup-error', error, false)}
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signup-password">Password</Label>
                <Input
                  id="signup-password"
                  {...fieldErrorProps('signup-error', error, false)}
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
              {error && <AuthFormError id="signup-error">{error}</AuthFormError>}
              <Button type="submit" variant="primary" disabled={submitting} className="mt-1 w-full">
                {submitting ? <Spinner /> : <UserPlus />} Create account
              </Button>
              <Link
                to="/auth/login"
                className="text-center text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Already have an account? Sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

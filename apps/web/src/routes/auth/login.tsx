import { useNavigate } from '@tanstack/react-router';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { authClient } from '~/lib/auth-client';

export function LoginPage() {
  const navigate = useNavigate();
  const { data: status, isLoading } = useAuthStatus();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const result = await authClient.signIn.email({ email, password });

    if (result.error) {
      setError(result.error.message ?? 'Unable to sign in. Check your email and password.');
      setSubmitting(false);
      return;
    }

    await navigate({ to: '/' });
  }

  async function handleSso(providerId: string) {
    setError(null);
    await authClient.signIn.sso({ providerId, callbackURL: '/' });
  }

  const appName = status?.branding.appName;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark name={appName} className="text-2xl" />
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
            {status?.localAuthEnabled && (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                  <p className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  disabled={submitting}
                  className="mt-1 w-full"
                >
                  {submitting ? <Spinner className="text-white" /> : <KeyRound />}
                  Sign in
                </Button>
              </form>
            )}

            {status && status.ssoProviders.length > 0 && (
              <>
                {status.localAuthEnabled && (
                  <div className="my-5 flex items-center gap-3">
                    <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                    <span className="text-[0.6875rem] uppercase tracking-wider text-[var(--text-muted)]">
                      or
                    </span>
                    <span className="h-px flex-1 bg-[var(--border-subtle)]" />
                  </div>
                )}

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

            {status?.registrationMode === 'open' && (
              <p className="mt-5 text-center text-xs text-[var(--text-muted)]">
                Registration is open. Account creation is added with the sign-up flow.
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

import { CheckCircle2, UserPlus } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Wordmark } from '~/components/brand/wordmark';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Spinner } from '~/components/ui/spinner';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { ApiError, api } from '~/lib/api-client';

type InviteState = 'checking' | 'valid' | 'invalid' | 'accepted';

interface ValidateInviteResponse {
  emailLocked: boolean;
}

interface AcceptInviteResponse {
  emailVerificationRequired: boolean;
}

/**
 * Public invitation registration surface. The router should mount this at
 * `/auth/accept-invite`; it intentionally lives outside authenticated layouts.
 */
export function AcceptInvitePage() {
  const { data: authStatus } = useAuthStatus();
  const [token] = useState(() => {
    const fragmentToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
    // Query support keeps previously issued links functional; new links use a
    // fragment so the token never reaches HTTP request/access logs.
    return fragmentToken ?? new URLSearchParams(window.location.search).get('token') ?? '';
  });
  const [inviteState, setInviteState] = useState<InviteState>('checking');
  const [emailLocked, setEmailLocked] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verificationRequired, setVerificationRequired] = useState(false);

  useEffect(() => {
    // Remove the bearer token from the address bar/history before making any
    // requests so it is less likely to leak through screenshots or copied URLs.
    window.history.replaceState(null, '', window.location.pathname);

    if (!token) {
      setInviteState('invalid');
      return;
    }

    let active = true;
    api
      .post<ValidateInviteResponse>('/auth/accept-invite/validate', { token })
      .then((result) => {
        if (!active) return;
        setEmailLocked(result.emailLocked);
        setInviteState('valid');
      })
      .catch(() => {
        if (active) setInviteState('invalid');
      });

    return () => {
      active = false;
    };
  }, [token]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await api.post<AcceptInviteResponse>('/auth/accept-invite', {
        token,
        name,
        email,
        password,
      });
      setVerificationRequired(result.emailVerificationRequired);
      setInviteState('accepted');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Unable to accept this invitation.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Wordmark
            name={authStatus?.branding.appName}
            shortName={authStatus?.branding?.shortName}
            logoUrl={authStatus?.branding?.logoUrl}
            className="text-2xl"
          />
          <p className="text-sm text-[var(--text-muted)]">Create your invited account.</p>
        </div>

        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6 backdrop-blur-sm">
          {inviteState === 'checking' && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--text-muted)]">
              <Spinner className="size-4" /> Checking invitation
            </div>
          )}

          {inviteState === 'invalid' && (
            <div className="space-y-4 text-center">
              <h1 className="text-lg font-semibold">Invitation unavailable</h1>
              <p className="text-sm text-[var(--text-muted)]">
                This link is invalid, expired, already used, or registration is unavailable.
              </p>
              <Button className="w-full" onClick={() => window.location.assign('/auth/login')}>
                Return to sign in
              </Button>
            </div>
          )}

          {inviteState === 'valid' && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-name">Name</Label>
                <Input
                  id="invite-name"
                  autoComplete="name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={320}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                {emailLocked && (
                  <p className="text-xs text-[var(--text-muted)]">
                    Enter the email address this invitation was sent to.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-password">Password</Label>
                <Input
                  id="invite-password"
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
                <p className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]">
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" disabled={submitting} className="mt-1 w-full">
                {submitting ? <Spinner /> : <UserPlus />}
                Accept invitation
              </Button>
            </form>
          )}

          {inviteState === 'accepted' && (
            <div className="space-y-4 text-center">
              <CheckCircle2 className="mx-auto size-9 text-[var(--accent-bright)]" />
              <h1 className="text-lg font-semibold">Account created</h1>
              <p className="text-sm text-[var(--text-muted)]">
                {verificationRequired
                  ? 'Check your email to verify your address before signing in.'
                  : 'Your invitation has been accepted. You can sign in now.'}
              </p>
              <Button
                variant="primary"
                className="w-full"
                onClick={() => window.location.assign('/auth/login')}
              >
                Continue to sign in
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

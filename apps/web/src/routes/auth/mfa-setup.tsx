import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { TwoStepPanel } from '~/components/mfa/two-step-panel';
import { Button } from '~/components/ui/button';
import { authClient } from '~/lib/auth-client';
import { mfaDeadlineText, useMfaStatus } from '~/lib/mfa';

/**
 * Where a limited person is sent (#399): their role requires two-step
 * verification and the deadline has passed, so the server refuses everything but
 * this and signing out. Outside the app shell, one paragraph, the enrolment
 * panel and Sign out. An authenticator is the way here: it is what makes this
 * session satisfied the moment it is confirmed, with no second sign-in.
 */
export function MfaSetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: status } = useMfaStatus();
  // A second step is set up, but this session began with the password alone
  // (once one is confirmed here the session is replaced and no longer limited).
  const signInAgain = status?.enrolled === true && status.limited;

  async function finish() {
    // The session was replaced when the code was confirmed: no longer limited.
    await queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    await navigate({ to: '/' });
  }

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pt-[10vh] pb-12">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-bold">Set up two-step verification</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          {signInAgain ? (
            <>
              Your administrator requires two-step verification, and you have it set up, but this
              session was opened with your password only. Sign out and sign in again, then enter
              your code or use your passkey.
            </>
          ) : (
            <>
              Your administrator requires two-step verification for your account
              {status?.deadline ? ` (since ${mfaDeadlineText(status.deadline)})` : ''}. Until you
              set it up, this page and Sign out are all you can use.
            </>
          )}
        </p>

        <div className="mt-8 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-6">
          <TwoStepPanel mode="setup" onEnrolled={() => void finish()} />
        </div>

        <div className="mt-6">
          <Button
            type="button"
            variant={signInAgain ? 'accent' : 'ghost'}
            onClick={() => void signOut()}
          >
            <LogOut className="rtl:-scale-x-100" />
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

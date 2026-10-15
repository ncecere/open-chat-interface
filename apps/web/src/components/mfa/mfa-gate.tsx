import { MFA_SETUP_PATH } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { useCurrentUser } from '~/hooks/use-current-user';
import { onMfaRequired } from '~/lib/mfa-required';

/**
 * Keeps a limited person out of the application (#399).
 *
 * The server refuses a session whose role requires two-step verification, once
 * the grace has passed, everywhere but enrolment and sign-out, so a page of the
 * app would only show errors. `GET /api/me` says `mfa.limited`; the person goes
 * to the setup page (outside the shell, enrolment and Sign out only) and nothing
 * of the app is rendered meanwhile. A refusal found by a request in a tab that
 * was already open (the requirement started with no grace) makes the gate look
 * at `/api/me` again, as OnboardingGate does for the policy.
 */
export function MfaGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  const limited = data?.mfa?.limited === true;

  useEffect(
    () =>
      onMfaRequired(() => {
        // Exactly /api/me: the queries under it (the policy, a limited session's
        // refused reads) would only be refused again.
        void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
      }),
    [queryClient],
  );

  useEffect(() => {
    if (limited) void navigate({ to: MFA_SETUP_PATH, replace: true });
  }, [limited, navigate]);

  if (limited) return null;
  return <>{children}</>;
}

import type { OnboardingState } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { IntroductionWizard } from '~/components/onboarding/introduction-wizard';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { onPolicyRequired } from '~/lib/policy-required';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';

/**
 * The acceptable use policy.
 *
 * Blocking rather than dismissable: an instance that requires agreement needs
 * the person to actually agree, and a policy someone can wave away is not one
 * they have accepted. The button stays disabled until the text has been
 * scrolled to the end, so accepting is at least a deliberate act.
 */
function PolicyGate({ policy }: { policy: NonNullable<OnboardingState['pendingPolicy']> }) {
  const queryClient = useQueryClient();
  const [readToEnd, setReadToEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));

  const accept = useMutation({
    mutationFn: () => api.post('/me/onboarding/accept-policy', { policyId: policy.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me', 'onboarding'] }),
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'The acceptance could not be recorded.'),
  });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-app)] px-4 py-10">
      <div className="flex max-h-[85dvh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-6">
        <h1 className="font-semibold text-xl">{policy.title}</h1>
        <p className="mt-1 text-[var(--text-muted)] text-sm">
          {policy.isUpdate
            ? 'This policy has changed since you last accepted it. Please read it again.'
            : 'Please read and accept this policy to continue.'}
        </p>

        <div
          className="scrollbar-thin mt-5 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 p-4 text-[var(--text-secondary)] text-sm leading-relaxed"
          onScroll={(event) => {
            const el = event.currentTarget;
            // A short policy may not scroll at all, which still counts as read.
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setReadToEnd(true);
          }}
          ref={(el) => {
            if (el && el.scrollHeight <= el.clientHeight) setReadToEnd(true);
          }}
        >
          {policy.body}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[var(--danger)] text-sm">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-4">
          <p className="text-[var(--text-muted)] text-xs">
            {readToEnd ? `Version ${policy.version}` : 'Scroll to the end to continue.'}
          </p>
          <Button
            variant="primary"
            disabled={!readToEnd || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending && <Spinner />}I accept
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Stands between a signed-in person and the application.
 *
 * The policy is a hard gate; the introduction is a soft one that can be
 * skipped. While the state is loading nothing is rendered, so the application
 * never flashes into view before a required policy appears.
 */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // The server refuses a write until the published policy is accepted (#367):
  // a tab opened before a new version came out, whose answer here is up to
  // five minutes old, looks again and shows the acceptance page.
  useEffect(
    () =>
      onPolicyRequired(() => {
        void queryClient.invalidateQueries({ queryKey: ['me', 'onboarding'] });
      }),
    [queryClient],
  );
  const { data, isLoading } = useQuery({
    queryKey: ['me', 'onboarding'],
    queryFn: () => api.get<OnboardingState>('/me/onboarding'),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return null;
  if (data?.pendingPolicy) return <PolicyGate policy={data.pendingPolicy} />;
  if (data?.needsIntroduction) return <IntroductionWizard />;

  return <>{children}</>;
}

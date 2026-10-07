import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useAutoRetry } from '~/hooks/use-auto-retry';

export function ConversationLoadError({
  unavailable,
  retry,
  retrying = false,
}: {
  unavailable: boolean;
  retry: () => void;
  retrying?: boolean;
}) {
  // A database outage of a minute left this on screen after it was over,
  // until Retry or a reload (#233): load again by itself every few seconds,
  // as "Could not load this page" does. Not for a conversation that is gone.
  useAutoRetry(!unavailable, retry);
  return (
    <UnavailableState
      alert
      title={unavailable ? 'Conversation unavailable' : 'Could not load conversation'}
      actions={
        unavailable ? (
          // Retrying cannot bring back a conversation that is gone (#103).
          <Button asChild>
            <Link to="/">New chat</Link>
          </Button>
        ) : (
          <>
            <Button type="button" onClick={retry} disabled={retrying}>
              Retry
            </Button>
            <Link to="/" className="text-sm underline">
              New chat
            </Link>
          </>
        )
      }
    >
      {unavailable
        ? 'This conversation may have been deleted, expired, or is not available to your account.'
        : 'Trying again by itself; check your connection if it does not load. No message has been sent from this loading screen.'}
    </UnavailableState>
  );
}

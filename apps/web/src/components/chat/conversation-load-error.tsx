import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';

export function ConversationLoadError({
  unavailable,
  retry,
  retrying = false,
}: {
  unavailable: boolean;
  retry: () => void;
  retrying?: boolean;
}) {
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
        : 'Check your connection and try again. No message has been sent from this loading screen.'}
    </UnavailableState>
  );
}

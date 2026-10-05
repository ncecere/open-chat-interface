import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';

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
    <div className="flex h-full items-center justify-center p-6">
      <section role="alert" className="max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold">
          {unavailable ? 'Conversation unavailable' : 'Could not load conversation'}
        </h1>
        <p className="text-sm text-[var(--text-muted)]">
          {unavailable
            ? 'This conversation may have been deleted, expired, or is not available to your account.'
            : 'Check your connection and try again. No message has been sent from this loading screen.'}
        </p>
        {unavailable ? (
          // Retrying cannot bring back a conversation that is gone (#103).
          <Button asChild>
            <Link to="/">New chat</Link>
          </Button>
        ) : (
          <div className="flex items-center justify-center gap-4">
            <Button type="button" onClick={retry} disabled={retrying}>
              Retry
            </Button>
            <Link to="/" className="text-sm underline">
              New chat
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

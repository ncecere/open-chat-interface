import { Link } from '@tanstack/react-router';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';

/**
 * An auth page whose status could not be loaded (the database or the API
 * down): an outage, not a sign that the feature is turned off (#288). The
 * status is asked for again every 5 s and the page's content appears once it
 * answers; the card stays up while each check is out (#307).
 */
export function AuthStatusUnavailable({
  title,
  refetch,
}: {
  title: string;
  refetch: () => Promise<unknown>;
}) {
  // A retry asked for with the button; the 5 s background refetch does not show.
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p role="status" className="text-sm text-[var(--text-muted)]">
        The service is temporarily unavailable. Try again in a moment.
      </p>
      <Button
        variant="primary"
        className="w-full"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          await refetch();
          setRetrying(false);
        }}
      >
        {retrying ? <Spinner /> : <RotateCw />} Try again
      </Button>
      <Link
        to="/auth/login"
        className="block text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        Return to sign in
      </Link>
    </div>
  );
}

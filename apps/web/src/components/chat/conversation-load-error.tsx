import { Link } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useAutoRetry } from '~/hooks/use-auto-retry';
import { useT } from '~/lib/i18n';

export function ConversationLoadError({
  unavailable,
  retry,
  retrying = false,
}: {
  unavailable: boolean;
  retry: () => void;
  retrying?: boolean;
}) {
  const t = useT();
  // A database outage of a minute left this on screen after it was over,
  // until Retry or a reload (#233): load again by itself every few seconds,
  // as "Could not load this page" does. Not for a conversation that is gone.
  useAutoRetry(!unavailable, retry);
  return (
    <UnavailableState
      alert
      title={unavailable ? t('chat.loadError.unavailableTitle') : t('chat.loadError.failedTitle')}
      actions={
        unavailable ? (
          // Retrying cannot bring back a conversation that is gone (#103).
          <Button asChild>
            <Link to="/">{t('chat.loadError.newChat')}</Link>
          </Button>
        ) : (
          <>
            <Button type="button" onClick={retry} disabled={retrying}>
              {t('chat.loadError.retry')}
            </Button>
            <Link to="/" className="text-sm underline">
              {t('chat.loadError.newChat')}
            </Link>
          </>
        )
      }
    >
      {unavailable ? t('chat.loadError.unavailableBody') : t('chat.loadError.failedBody')}
    </UnavailableState>
  );
}

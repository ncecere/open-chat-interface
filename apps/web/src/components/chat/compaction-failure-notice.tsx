import type { CompactionFailureReason } from '@oci/shared';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import {
  useCompactionFailure,
  useCompactThread,
  useDismissCompactionFailure,
} from '~/hooks/use-compaction';
import { apiErrorMessage } from '~/lib/api-client';

export const COMPACTION_FAILED_TEXT = 'The summary you asked for could not be made.';

/** Why, in the person's terms. */
export const COMPACTION_FAILURE_TEXT: Record<CompactionFailureReason, string> = {
  allowance: 'Your usage allowance ran out before it was made. Try again when it resets.',
  model_error: 'The model returned an error.',
  nothing_to_summarise: 'There was nothing to summarise yet.',
  timeout: 'The model took too long to answer.',
};

/**
 * A quiet notice under the conversation when a summary the person asked for
 * ("Summarise earlier messages now") failed in the background: why, with
 * Retry (the same instructions) and Dismiss. Automatic summaries are never
 * reported; the conversation works the same either way.
 */
export function CompactionFailureNotice({ threadId }: { threadId: string }) {
  const failure = useCompactionFailure(threadId);
  const retry = useCompactThread(threadId);
  const dismiss = useDismissCompactionFailure(threadId);
  if (!failure) return null;
  const busy = retry.isPending || dismiss.isPending;
  const error = retry.error ?? dismiss.error;
  return (
    <div
      role="status"
      data-compaction-failure={failure.reason}
      className="mx-auto flex max-w-[42rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-4 text-xs text-[var(--text-muted)]"
    >
      <p className="min-w-0 flex-1">
        {COMPACTION_FAILED_TEXT} {COMPACTION_FAILURE_TEXT[failure.reason]}
      </p>
      <div className="flex items-center gap-1">
        {/* Asking again cannot help while there is nothing to summarise. */}
        {failure.reason !== 'nothing_to_summarise' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => retry.mutate(failure.instructions ?? '')}
          >
            {retry.isPending && <Spinner />}
            Retry
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => dismiss.mutate()}
        >
          Dismiss
        </Button>
      </div>
      {error && (
        <p role="alert" className="w-full text-[var(--danger-on-tint)]">
          {apiErrorMessage(error, 'That did not work. Try again in a moment.')}
        </p>
      )}
    </div>
  );
}

import type { CompactionFailureReason } from '@oci/shared';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import {
  useCompactionFailure,
  useCompactThread,
  useDismissCompactionFailure,
} from '~/hooks/use-compaction';
import { apiErrorMessage } from '~/lib/api-client';
import { type MessageKey, translate, useT } from '~/lib/i18n';

export const compactionFailedText = (): string => translate('chat.compaction.failedText');

/** Why, in the person's terms. */
export const compactionFailureText = (reason: CompactionFailureReason): string =>
  translate(COMPACTION_FAILURE_KEYS[reason]);

const COMPACTION_FAILURE_KEYS = {
  allowance: 'chat.compaction.failureAllowance',
  model_error: 'chat.compaction.failureModelError',
  nothing_to_summarise: 'chat.compaction.failureNothingToSummarise',
  timeout: 'chat.compaction.failureTimeout',
} as const satisfies Record<CompactionFailureReason, MessageKey>;

/**
 * A quiet notice under the conversation when a summary the person asked for
 * ("Summarise earlier messages now") failed in the background: why and what
 * to do (#363), with Retry (the same instructions, with the model now in the
 * picker) and Dismiss. Automatic summaries are never
 * reported; the conversation works the same either way.
 */
export function CompactionFailureNotice({ threadId }: { threadId: string }) {
  const t = useT();
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
        {t('chat.compaction.failedText')} {t(COMPACTION_FAILURE_KEYS[failure.reason])}
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
            {t('chat.compaction.retry')}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => dismiss.mutate()}
        >
          {t('chat.compaction.dismiss')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="w-full text-[var(--danger-on-tint)]">
          {apiErrorMessage(error, t('chat.compaction.retryFailed'))}
        </p>
      )}
    </div>
  );
}

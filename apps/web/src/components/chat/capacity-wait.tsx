import { type CapacityWaitData, capacityWaitOfPart } from '@oci/shared';
import type { UIMessage } from 'ai';
import { Hourglass, Square } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { useMediaQuery } from '~/hooks/use-media-query';
import { cn } from '~/lib/utils';

/**
 * A reply waiting for its model's provider (v0.11): OCI keeps below the
 * provider's rate limits and queues turns fairly instead of failing them.
 * The latest `data-capacity` part says where the turn stands.
 */
export function capacityWaitOf(message: UIMessage): CapacityWaitData | null {
  if (message.role !== 'assistant') return null;
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const wait = capacityWaitOfPart(message.parts[index]);
    if (wait) return wait;
  }
  return null;
}

/** "about 40 seconds", "about 3 minutes"; null when unknown. */
export function waitEstimate(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 10) return 'a few seconds';
  if (seconds < 90) return `about ${Math.round(seconds / 5) * 5} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function capacityWaitLabel(wait: CapacityWaitData): string {
  const model = wait.model || 'the model';
  return wait.position === null
    ? `Waiting for ${model}`
    : `Waiting for ${model} — you’re number ${wait.position}`;
}

/** Where the work block will be: the place in the queue, its estimate, and Stop. */
export function CapacityWait({ wait, onStop }: { wait: CapacityWaitData; onStop?: () => void }) {
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const estimate = waitEstimate(wait.estimatedWaitSeconds);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2" data-capacity-wait="">
      <div role="status" aria-live="polite" className="min-w-0">
        <p className="flex items-center gap-2 text-[0.8125rem] font-medium text-[var(--text-primary)]">
          <Hourglass
            aria-hidden="true"
            className={cn('size-4 shrink-0', !reduceMotion && 'motion-safe:animate-pulse')}
          />
          <span className="min-w-0 break-words">{capacityWaitLabel(wait)}</span>
        </p>
        <p className="mt-0.5 pl-6 text-xs text-[var(--text-muted)]">
          The model is busy, so messages take turns.
          {estimate ? ` Your reply should start in ${estimate}.` : ''}
        </p>
      </div>
      {onStop && (
        <Button variant="secondary" size="sm" onClick={onStop} aria-label="Stop waiting">
          <Square aria-hidden="true" />
          Stop
        </Button>
      )}
    </div>
  );
}

function duration(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** What a finished reply says about its wait: how long, or that it ran out. */
export function CapacityNote({ wait }: { wait: CapacityWaitData }) {
  if (wait.state === 'admitted' && wait.waitedSeconds >= 5)
    return (
      <p role="note" className="mb-2 text-xs text-[var(--text-muted)]">
        Waited {duration(wait.waitedSeconds)} for {wait.model || 'the model'}.
      </p>
    );
  if (wait.state === 'timeout')
    return (
      <p role="note" className="mb-2 text-xs text-[var(--text-muted)]">
        {wait.model || 'The model'} was busy for too long, so this reply did not start. Try again in
        a few minutes.
      </p>
    );
  return null;
}

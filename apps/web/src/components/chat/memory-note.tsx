import type { MemoryToolResult } from '@oci/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { Brain } from 'lucide-react';
import { useContext, useState } from 'react';
import { Button } from '~/components/ui/button';
import { apiErrorMessage } from '~/lib/api-client';
import { MEMORY_QUERY_KEY, undoMemoryStep } from '~/lib/memory';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';

type Status = 'idle' | 'pending' | 'undone';

/**
 * "Memory updated" under a reply whose model saved or removed a memory, with
 * the note's text and an Undo action. Undo deletes a saved note or restores a
 * removed one; Settings → Memory shows the result.
 */
export function MemoryNote({
  messageId,
  toolCallId,
  change,
  canUndo = true,
}: {
  messageId: string;
  toolCallId: string;
  change: MemoryToolResult & { action: 'added' | 'removed' };
  /** False where the reply cannot be acted on, such as while it is still streaming. */
  canUndo?: boolean;
}) {
  // Rendered in conversations and in tests without a query client.
  const queryClient = useContext(QueryClientContext);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));

  async function undo() {
    setStatus('pending');
    setError(null);
    try {
      await undoMemoryStep(messageId, toolCallId);
      setStatus('undone');
      void queryClient?.invalidateQueries({ queryKey: MEMORY_QUERY_KEY });
    } catch (cause) {
      setStatus('idle');
      setError(apiErrorMessage(cause, 'The change could not be undone. Try again.'));
    }
  }

  const verb = change.action === 'added' ? 'Remembered' : 'Forgot';
  return (
    <div
      role="note"
      aria-label="Memory updated"
      data-testid="memory-note"
      className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-3 py-2 text-[0.8125rem]"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Brain className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--text-primary)]">Memory updated</p>
          <p className="break-words text-[var(--text-secondary)]">
            {verb}: {change.content}
          </p>
        </div>
        {status === 'undone' ? (
          <span role="status" className="shrink-0 text-xs text-[var(--text-muted)]">
            Undone
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={!canUndo || status === 'pending'}
            aria-label={
              change.action === 'added' ? 'Undo: forget this' : 'Undo: remember this again'
            }
            onClick={() => void undo()}
          >
            Undo
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

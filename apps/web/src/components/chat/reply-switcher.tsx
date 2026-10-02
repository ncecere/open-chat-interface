import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '~/components/ui/button';

export interface ReplySwitch {
  /** Zero-based position of the reply on screen among all replies to the turn. */
  index: number;
  count: number;
  /** While a reply generates or a switch is being saved. */
  disabled: boolean;
  onSelect: (index: number) => void;
}

/**
 * "‹ 2 / 3 ›" for the latest turn's retried replies. The buttons stay
 * focusable when unavailable (aria-disabled), so focus is not dropped when
 * the first or last reply is reached or a reply starts generating.
 */
export function ReplySwitcher({ index, count, disabled, onSelect }: ReplySwitch) {
  const previous = disabled || index <= 0;
  const next = disabled || index >= count - 1;

  return (
    <fieldset
      aria-label="Replies"
      className="m-0 mt-2 flex min-w-0 items-center gap-0.5 border-0 p-0 text-xs text-[var(--text-muted)]"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous reply"
        aria-disabled={previous}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        onClick={() => {
          if (!previous) onSelect(index - 1);
        }}
      >
        <ChevronLeft />
      </Button>
      <span aria-hidden="true" className="min-w-10 text-center tabular-nums">
        {index + 1} / {count}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next reply"
        aria-disabled={next}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        onClick={() => {
          if (!next) onSelect(index + 1);
        }}
      >
        <ChevronRight />
      </Button>
      <span role="status" className="sr-only">
        Reply {index + 1} of {count}
      </span>
    </fieldset>
  );
}

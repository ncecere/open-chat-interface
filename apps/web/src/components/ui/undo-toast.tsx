import { toast } from 'sonner';

/**
 * How long a notice with Undo stays (#205). Sonner's default of 4 seconds was
 * too short to notice the notice and reach its button, above all from the
 * keyboard (Alt+T, then Tab) or a screen reader.
 */
export const UNDO_TOAST_DURATION_MS = 10_000;

/**
 * A success notice with an Undo button. Sonner already pauses its timer while
 * the pointer is over the notices or Alt+T has moved focus to them; it does
 * not when the button is reached with Tab, so the notice stays without a
 * timer while its button has focus, and gets its full time again after.
 */
export function undoToast(input: {
  id: string;
  title: string;
  description?: string;
  onUndo: () => void;
}): void {
  // Once closed, a late blur must not bring the notice back.
  let closed = false;
  const close = () => {
    closed = true;
  };
  const show = (duration: number) => {
    if (closed) return;
    toast.success(input.title, {
      id: input.id,
      description: input.description,
      duration,
      onDismiss: close,
      onAutoClose: close,
      action: (
        <button
          type="button"
          data-button=""
          data-action=""
          onFocus={() => show(Number.POSITIVE_INFINITY)}
          onBlur={() => show(UNDO_TOAST_DURATION_MS)}
          onClick={() => {
            close();
            toast.dismiss(input.id);
            input.onUndo();
          }}
        >
          Undo
        </button>
      ),
    });
  };
  show(UNDO_TOAST_DURATION_MS);
}

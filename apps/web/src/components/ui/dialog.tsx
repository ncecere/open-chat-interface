import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useFocusReturn } from '~/hooks/use-focus-return';
import { keepHiddenContentInert } from '~/lib/inert-hidden';
import { cn } from '~/lib/utils';

// A modal dialog hides the page; it is also made inert, so nothing hidden takes focus (#172).
keepHiddenContentInert();

export const Dialog = DialogPrimitive.Root;

const DISCARD_QUESTION = 'Discard what you have entered?';
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  closeButton = true,
  confirmDiscard = false,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** False when the dialog lays out its own Close button (use DialogClose). */
  closeButton?: boolean;
  /**
   * The form inside has unsaved input: Escape or a click outside asks before
   * discarding it, instead of closing at once (#45). Cancel and × still close.
   */
  confirmDiscard?: boolean;
}) {
  // Focus goes back to whatever opened the dialog, or near it if it has gone
  // (WCAG 2.4.3; #41, #128).
  const focusReturn = useFocusReturn();

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          // On a phone every dialog is a card 16 px in from each edge (#199):
          // the base was full-bleed (w-full), so only dialogs that narrowed
          // themselves were inset, and the two looked like different apps.
          'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-6',
          'shadow-[var(--shadow-popover)]',
          className,
        )}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (!event.defaultPrevented && confirmDiscard && !window.confirm(DISCARD_QUESTION))
            event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          onPointerDownOutside?.(event);
          if (!event.defaultPrevented && confirmDiscard && !window.confirm(DISCARD_QUESTION))
            event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          focusReturn.onOpenAutoFocus();
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          focusReturn.onCloseAutoFocus(event);
        }}
        {...props}
      >
        {children}
        {closeButton && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mb-4 flex flex-col gap-1.5', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-sm text-[var(--text-muted)]', className)}
      {...props}
    />
  );
}

/**
 * The actions, a right-aligned row at every width (#199): some dialogs stacked
 * theirs on a phone, Cancel under the action, and the rest kept the row. A
 * pair that does not fit wraps instead.
 */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-wrap justify-end gap-2', className)} {...props} />;
}

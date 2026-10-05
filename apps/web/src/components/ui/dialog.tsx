import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type ComponentProps, useRef } from 'react';
import { cn } from '~/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  closeButton = true,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  /** False when the dialog lays out its own Close button (use DialogClose). */
  closeButton?: boolean;
}) {
  /**
   * WCAG 2.4.3 Focus Order.
   *
   * These dialogs open from component state rather than a DialogTrigger, so
   * Radix has no trigger to hand focus back to and it falls to the body.
   * Remembering the element that was focused at open time and restoring it
   * keeps a keyboard user where they were.
   *
   * The opener is read in onOpenAutoFocus, which Radix fires on every open
   * before it moves focus into the dialog. An effect cannot do this: this
   * component stays mounted while the dialog is closed, and a child's effects
   * (Radix's FocusScope) run before a parent's, so an effect sees either the
   * page-load focus or an element inside the dialog, never the opener.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-6',
          'shadow-[var(--shadow-popover)]',
          className,
        )}
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          openerRef.current =
            active instanceof HTMLElement && active !== document.body ? active : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;

          const opener = openerRef.current;
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
          }
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

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex justify-end gap-2', className)} {...props} />;
}

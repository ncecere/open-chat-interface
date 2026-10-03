import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAdminAccess } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';

/**
 * Confirmation step for a destructive admin action.
 *
 * The action runs inside the dialog: it stays open while pending (Escape and
 * Cancel are ignored until it settles), closes on success, and on failure
 * keeps the dialog open with the error so the admin can retry or cancel.
 * Radix moves focus to the first button, which is Cancel, so pressing Enter
 * straight away never confirms by accident.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel = 'Working…',
  errorMessage,
  onConfirm,
  confirmDisabled = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  /** What failed, shown above the server's explanation. */
  errorMessage: string;
  /** Should resolve once the change is complete, including any refetch. */
  onConfirm: () => Promise<unknown>;
  /** Holds the confirm button back, for example until a typed confirmation matches. */
  confirmDisabled?: boolean;
  children?: ReactNode;
}) {
  // Triggers are hidden from read-only viewers; this is the backstop.
  const { canEdit } = useAdminAccess();
  const action = useMutation({
    mutationFn: onConfirm,
    onSuccess: () => onOpenChange(false),
  });

  function handleOpenChange(next: boolean) {
    if (!next && action.isPending) return;
    if (!next) action.reset();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {open && (
        <DialogContent className="w-[calc(100%-2rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {children}

          <MutationError error={action.error} message={errorMessage} className="mt-3" />

          <DialogFooter className="flex-col-reverse sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={action.isPending || !canEdit || confirmDisabled}
              onClick={() => action.mutate()}
            >
              {action.isPending && <Spinner />}
              {action.isPending ? pendingLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

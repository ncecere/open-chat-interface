import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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
import { useT } from '~/lib/i18n';

/**
 * The confirmation step for a destructive action in Settings (delete account,
 * empty the trash, delete a file, revoke a link). The administration console
 * has its own, which stays in English; this one is translated.
 *
 * The action runs inside the dialog: it stays open while pending (Escape and
 * Cancel are ignored until it settles), closes on success, and on failure keeps
 * the dialog open with the error so the person can retry or cancel. Radix moves
 * focus to the first button, which is Cancel, so pressing Enter straight away
 * never confirms by accident.
 */
export function SettingsConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
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
  /** Shown on the confirm button while the action runs; "Working…" when omitted. */
  pendingLabel?: string;
  /** What failed, shown above the server's explanation. */
  errorMessage: string;
  /** Should resolve once the change is complete, including any refetch. */
  onConfirm: () => Promise<unknown>;
  /** Holds the confirm button back, for example until a typed confirmation matches. */
  confirmDisabled?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
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

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => handleOpenChange(false)}
            >
              {t('settings.confirm.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={action.isPending || confirmDisabled}
              onClick={() => action.mutate()}
            >
              {action.isPending && <Spinner />}
              {action.isPending ? (pendingLabel ?? t('settings.confirm.working')) : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

import { useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { EditOnly } from '~/components/admin/admin-access';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { DEFAULT_STORAGE_TAB, type StorageTab, validateStorageSearch } from '~/lib/admin-search';
import { DriverPanel, DriverWarning } from './driver-panel';
import { S3Panel } from './s3-panel';
import type { StorageSettings } from './storage-draft';
import { UploadsPanel } from './uploads-panel';
import { useStorageSettings } from './use-storage-settings';

const STORAGE_TABS = [
  { id: 'driver', label: 'Storage driver' },
  { id: 's3', label: 'S3 connection' },
  { id: 'uploads', label: 'Upload policy' },
] as const satisfies readonly PillTab<StorageTab>[];

export function StorageSettingsForm({ initialSettings }: { initialSettings: StorageSettings }) {
  // The tab lives in the URL; switching only toggles `hidden`, so every panel
  // stays mounted and the shared draft survives. So a tab change loses nothing
  // and skips the unsaved-changes question, which is for leaving the page (#45).
  const navigate = useNavigate();
  const tab = validateStorageSearch(useSearch({ strict: false })).tab ?? DEFAULT_STORAGE_TAB;
  const setTab = (next: StorageTab) =>
    void navigate({
      to: '/admin/storage',
      search: { tab: next === DEFAULT_STORAGE_TAB ? undefined : next },
      replace: true,
      ignoreBlocker: true,
    });
  const controller = useStorageSettings(initialSettings);
  const {
    draft,
    showDriverConfirmation,
    setShowDriverConfirmation,
    successMessage,
    errorMessage,
    healthMessage,
    patch,
    hasChanges,
    save,
    submitChanges,
  } = controller;

  return (
    <>
      <form
        className="flex flex-col gap-8"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitChanges();
        }}
      >
        <PillTabs tabs={STORAGE_TABS} active={tab} onChange={setTab} label="Storage sections" />

        {/* All panels stay mounted and share one draft and one save across tabs. */}
        <div hidden={tab !== 'driver'} id="panel-driver" role="tabpanel">
          <DriverPanel controller={controller} localPath={initialSettings.localPath} />
        </div>

        <div hidden={tab !== 's3'} id="panel-s3" role="tabpanel">
          <S3Panel controller={controller} />
        </div>

        <div hidden={tab !== 'uploads'} id="panel-uploads" role="tabpanel">
          <UploadsPanel controller={controller} />
        </div>

        <EditOnly>
          <div className="flex min-h-9 flex-col gap-3 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center sm:justify-end">
            <div className="sm:mr-auto" aria-live="polite">
              {errorMessage && (
                <p role="alert" className="text-sm text-[var(--danger)]">
                  {errorMessage}
                </p>
              )}
              {successMessage && (
                <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                  <CheckCircle2 className="size-4" /> Storage settings saved.
                </p>
              )}
              {healthMessage && (
                <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                  <CheckCircle2 className="size-4" /> {healthMessage}
                </p>
              )}
            </div>
            <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
              {save.isPending && <Spinner />}
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </EditOnly>
      </form>

      <Dialog open={showDriverConfirmation} onOpenChange={setShowDriverConfirmation}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change the active storage driver?</DialogTitle>
            <DialogDescription>
              This changes where all attachment reads and new writes are directed. It does not copy
              existing files.
            </DialogDescription>
          </DialogHeader>
          <DriverWarning driver={draft.driver} />
          {draft.driver === 's3' && (
            <p className="text-sm text-[var(--text-muted)]">
              The server will reject this change unless the bucket, region, access key ID, and
              encrypted secret are all configured. Test the saved connection before switching.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setShowDriverConfirmation(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={save.isPending}
              onClick={() => save.mutate(patch)}
            >
              {save.isPending && <Spinner />}
              Change driver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

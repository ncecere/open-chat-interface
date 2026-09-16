import type { StorageDriver } from '@oci/shared';
import { AlertTriangle, HardDrive } from 'lucide-react';
import { SettingsSection } from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
import { Select } from '~/components/ui/select';
import type { StorageSettingsController } from './use-storage-settings';

export function DriverWarning({ driver }: { driver: StorageDriver }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div>
        <p className="font-medium text-[var(--text-primary)]">
          Changing to {driver === 's3' ? 'S3' : 'local storage'} does not move existing files
        </p>
        <p className="mt-1 leading-relaxed text-[var(--text-muted)]">
          Reads switch to the selected backend immediately. Migrate existing objects first and keep
          the previous backend recoverable, or existing attachments may become unavailable.
        </p>
      </div>
    </div>
  );
}

export function DriverPanel({
  controller,
  localPath,
}: {
  controller: Pick<
    StorageSettingsController,
    'draft' | 'setDraft' | 'save' | 'beginEdit' | 'driverChanged'
  >;
  localPath: string;
}) {
  const { draft, setDraft, save, beginEdit, driverChanged } = controller;

  return (
    <SettingsSection
      title="Storage driver"
      description="Select where attachments are stored. Invalid S3 settings are never allowed to fall back silently to local storage."
    >
      <div className="flex flex-col gap-5">
        <Field label="Driver" htmlFor="storage-driver">
          <Select
            id="storage-driver"
            value={draft.driver}
            disabled={save.isPending}
            onChange={(next) => {
              beginEdit();
              setDraft((current) => ({ ...current, driver: next as StorageDriver }));
            }}
            options={[
              { value: 'local', label: 'Local filesystem' },
              { value: 's3', label: 'S3-compatible object storage' },
            ]}
          />
        </Field>

        {driverChanged && <DriverWarning driver={draft.driver} />}

        {draft.driver === 'local' && (
          <div className="flex gap-3 rounded-xl border border-[var(--border-subtle)] p-4 text-sm">
            <HardDrive className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" />
            <div className="min-w-0">
              <p className="font-medium">Local filesystem path</p>
              <code className="mt-1 block break-all rounded bg-black/20 px-2 py-1 text-xs text-[var(--text-secondary)]">
                {localPath}
              </code>
              <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
                Set by the deployment, since the path has to exist inside the container. Change it
                with the STORAGE_LOCAL_PATH environment variable, and make sure the volume behind it
                is persistent and backed up.
              </p>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

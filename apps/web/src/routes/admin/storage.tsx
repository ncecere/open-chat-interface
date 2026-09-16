import type { InstanceSettings } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { StorageSettingsForm } from './storage/storage-settings-form';

function LoadingStorageSettings() {
  return (
    <div
      className="flex max-w-3xl items-center gap-3 text-sm text-[var(--text-muted)]"
      role="status"
      aria-busy="true"
      aria-label="Loading storage settings"
    >
      <Spinner />
      Loading storage settings…
    </div>
  );
}

export function AdminStoragePage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettings>('/admin/settings'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Storage"
        description="Manage the attachment backend and upload policy for this instance."
      />

      {settings.isLoading ? (
        <LoadingStorageSettings />
      ) : settings.isError || !settings.data ? (
        <div className="max-w-3xl">
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load storage settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />} Try again
          </Button>
        </div>
      ) : (
        <StorageSettingsForm initialSettings={settings.data.storage} />
      )}
    </div>
  );
}

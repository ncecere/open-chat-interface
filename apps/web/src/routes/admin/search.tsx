import type { InstanceSettings } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { SearchSettingsForm } from './search/search-settings-form';

export { onThisPage } from './search/search-draft';

function LoadingSearchSettings() {
  return (
    <div
      className="flex items-center gap-3 text-sm text-[var(--text-muted)]"
      role="status"
      aria-busy="true"
      aria-label="Loading search settings"
    >
      <Spinner />
      Loading search settings…
    </div>
  );
}

export function AdminSearchPage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettings>('/admin/settings'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Web search"
        description="Configure web search grounding and its upstream provider."
      />

      {settings.isLoading ? (
        <LoadingSearchSettings />
      ) : settings.isError || !settings.data ? (
        <div>
          <p role="alert" className="text-sm text-[var(--danger)]">
            {apiErrorMessage(settings.error, 'Unable to load search settings.')}
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
        <SearchSettingsForm settings={settings.data} />
      )}
    </div>
  );
}

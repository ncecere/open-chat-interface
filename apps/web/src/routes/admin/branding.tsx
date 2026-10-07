import { instanceSettingsSchema } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { brandingFromResponse } from './branding/branding-draft';
import { BrandingForm } from './branding/branding-form';

function LoadingBranding() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]"
      role="status"
      aria-busy="true"
      aria-label="Loading branding settings"
    >
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
          <Spinner />
          Loading branding settings…
        </div>
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="animate-pulse">
            <div className="h-4 w-32 rounded bg-[var(--bg-control-hover)]" />
            <div className="mt-2 h-9 rounded bg-[var(--bg-control-hover)]" />
          </div>
        ))}
      </div>
      <div className="min-h-96 animate-pulse rounded-xl bg-[var(--bg-control-hover)]/50" />
    </div>
  );
}

export function AdminBrandingPage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => instanceSettingsSchema.parse(await api.get<unknown>('/admin/settings')),
  });

  return (
    <div>
      <AdminPageHeader
        title="Branding"
        description="Customize the identity and default appearance of your Open Chat Interface instance."
      />

      {settings.isLoading ? (
        <LoadingBranding />
      ) : settings.isError || !settings.data ? (
        <div>
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load branding settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />}
            Try again
          </Button>
        </div>
      ) : (
        <BrandingForm initialSettings={brandingFromResponse(settings.data)} />
      )}
    </div>
  );
}

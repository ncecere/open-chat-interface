import type { SsoProviderSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { SsoProviderForm } from '~/routes/admin/sso-provider-form';
import { DeleteSsoProviderDialog, SsoProviderList } from '~/routes/admin/sso-provider-list';

interface SsoProvidersResponse {
  providers: SsoProviderSummary[];
}

export function AdminSsoPage() {
  const [formProvider, setFormProvider] = useState<SsoProviderSummary | 'new' | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<SsoProviderSummary | null>(null);

  const providers = useQuery({
    queryKey: ['admin', 'sso', 'providers'],
    queryFn: () => api.get<SsoProvidersResponse>('/admin/sso/providers'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Auth & SSO"
        description="Connect OpenID Connect and SAML 2.0 identity providers, control account provisioning, and map identity claims to OCI roles."
        actions={
          <Button type="button" variant="primary" onClick={() => setFormProvider('new')}>
            <Plus />
            Add provider
          </Button>
        }
      />

      {providers.isLoading ? (
        <div
          className="flex min-h-56 items-center justify-center"
          role="status"
          aria-label="Loading SSO providers"
        >
          <Spinner className="size-6" />
        </div>
      ) : providers.isError || !providers.data ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center">
          <p role="alert" className="text-sm font-medium text-[var(--text-primary)]">
            SSO providers could not be loaded.
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {apiErrorMessage(providers.error, 'Unable to load SSO providers.')}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={providers.isFetching}
            onClick={() => void providers.refetch()}
          >
            {providers.isFetching && <Spinner />}
            Try again
          </Button>
        </div>
      ) : providers.data.providers.length > 0 ? (
        <SsoProviderList
          providers={providers.data.providers}
          onEdit={setFormProvider}
          onDelete={setDeleteProvider}
        />
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center">
          <ShieldCheck className="size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--text-primary)]">
            No SSO providers configured.
          </p>
          <p className="max-w-md text-xs text-[var(--text-muted)]">
            Add an OIDC or SAML 2.0 provider to offer centralized sign-in. You can keep it disabled
            while completing identity provider setup.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setFormProvider('new')}
          >
            <Plus />
            Add provider
          </Button>
        </div>
      )}

      <Dialog open={formProvider !== null} onOpenChange={(open) => !open && setFormProvider(null)}>
        {formProvider && (
          <SsoProviderForm
            provider={formProvider === 'new' ? undefined : formProvider}
            onClose={() => setFormProvider(null)}
          />
        )}
      </Dialog>

      <Dialog
        open={deleteProvider !== null}
        onOpenChange={(open) => !open && setDeleteProvider(null)}
      >
        {deleteProvider && (
          <DeleteSsoProviderDialog
            provider={deleteProvider}
            onClose={() => setDeleteProvider(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

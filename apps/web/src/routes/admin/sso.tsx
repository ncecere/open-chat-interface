import type { SsoProviderSummary } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { LoadError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { SsoProviderForm } from '~/routes/admin/sso-provider-form';
import { DeleteSsoProviderDialog, SsoProviderList } from '~/routes/admin/sso-provider-list';

/** Anchor the old /admin/sso address and setup notices point at. */
export const SINGLE_SIGN_ON_SECTION_ID = 'single-sign-on';

interface SsoProvidersResponse {
  providers: SsoProviderSummary[];
}

/**
 * OpenID Connect and SAML identity providers, shown on the Authentication page
 * beneath local sign-in so every way of signing in is configured in one place.
 */
export function SsoProvidersSection() {
  const [formProvider, setFormProvider] = useState<SsoProviderSummary | 'new' | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<SsoProviderSummary | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  // The section renders after settings load, which is too late for the
  // router's own hash scrolling when someone arrives from the old address.
  useEffect(() => {
    if (window.location.hash === `#${SINGLE_SIGN_ON_SECTION_ID}`) {
      sectionRef.current?.scrollIntoView?.();
    }
  }, []);

  const providers = useQuery({
    queryKey: ['admin', 'sso', 'providers'],
    queryFn: () => api.get<SsoProvidersResponse>('/admin/sso/providers'),
  });

  return (
    <section
      ref={sectionRef}
      id={SINGLE_SIGN_ON_SECTION_ID}
      aria-labelledby="single-sign-on-heading"
      className="flex scroll-mt-6 flex-col gap-5 border-t border-[var(--border-subtle)] pt-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2
            id="single-sign-on-heading"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            Single sign-on
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
            Connect OpenID Connect and SAML 2.0 identity providers, control account provisioning,
            and map identity claims to roles.
          </p>
        </div>
        <EditOnly>
          <Button type="button" variant="secondary" onClick={() => setFormProvider('new')}>
            <Plus />
            Add provider
          </Button>
        </EditOnly>
      </div>

      {providers.isLoading ? (
        <div
          className="flex min-h-32 items-center justify-center"
          role="status"
          aria-label="Loading SSO providers"
        >
          <Spinner className="size-6" />
        </div>
      ) : providers.isError || !providers.data ? (
        <LoadError title="SSO providers could not be loaded." query={providers} />
      ) : providers.data.providers.length > 0 ? (
        <SsoProviderList
          providers={providers.data.providers}
          onEdit={setFormProvider}
          onDelete={setDeleteProvider}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-8 text-center">
          <ShieldCheck className="size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--text-primary)]">
            No SSO providers configured.
          </p>
          <p className="max-w-md text-xs text-[var(--text-muted)]">
            Add an OIDC or SAML 2.0 provider to offer centralized sign-in. You can keep it disabled
            while completing identity provider setup.
          </p>
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
    </section>
  );
}

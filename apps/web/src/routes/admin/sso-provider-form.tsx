import type { CreateSsoProviderInput, SsoProviderSummary } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api, apiErrorMessage } from '~/lib/api-client';
import { OidcFields } from './sso-form/oidc-fields';
import { PolicyFields } from './sso-form/policy-fields';
import {
  EMPTY_PROTOCOL,
  type PatchSsoProviderBody,
  type PolicyDraft,
  type ProtocolDraft,
  type ProviderKind,
  policyFromProvider,
  toCreateBody,
  toPatchBody,
} from './sso-form/provider-draft';
import { SamlFields } from './sso-form/saml-fields';

export function SsoProviderForm({
  provider,
  onClose,
}: {
  provider?: SsoProviderSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = Boolean(provider);
  const [policy, setPolicy] = useState<PolicyDraft>(() => policyFromProvider(provider));
  const [protocol, setProtocol] = useState<ProtocolDraft>(EMPTY_PROTOCOL);
  const [validationError, setValidationError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (body: CreateSsoProviderInput | PatchSsoProviderBody) => {
      if (provider) {
        await api.patch<{ ok: boolean }>(`/admin/sso/providers/${provider.providerId}`, body);
      } else {
        await api.post<{ providerId: string }>('/admin/sso/providers', body);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'sso', 'providers'] }),
        queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
      ]);
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    save.reset();

    const result = provider ? toPatchBody(policy) : toCreateBody(policy, protocol);
    if (!result.success) {
      setValidationError(result.error);
      return;
    }
    save.mutate(result.data);
  }

  const formError =
    validationError ??
    (save.error ? apiErrorMessage(save.error, 'The SSO provider could not be saved.') : null);

  return (
    <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto p-4 sm:p-6">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${provider?.label}` : 'Add SSO provider'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Update sign-in access and user provisioning policy.'
            : 'Configure an OpenID Connect or SAML 2.0 identity provider.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-6">
        {provider ? (
          <section
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] p-4"
            aria-labelledby="protocol-summary-heading"
          >
            <h3 id="protocol-summary-heading" className="text-sm font-semibold">
              {provider.kind === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'} configuration
            </h3>
            <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-[var(--text-muted)]">Provider ID</dt>
                <dd className="break-all font-mono text-[var(--text-secondary)]">
                  {provider.providerId}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Issuer</dt>
                <dd className="break-all text-[var(--text-secondary)]">{provider.issuer}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              Protocol settings and credentials cannot be changed by the current API. Stored
              credentials are never returned to this page.
            </p>
          </section>
        ) : (
          <>
            <section className="grid gap-4 sm:grid-cols-2" aria-label="Provider identity">
              <Field
                label="Provider type"
                htmlFor="sso-kind"
                hint="The protocol cannot be changed after creation."
              >
                <Select
                  id="sso-kind"
                  value={protocol.kind}
                  disabled={save.isPending}
                  onChange={(next) => setProtocol({ ...protocol, kind: next as ProviderKind })}
                  options={[
                    { value: 'oidc', label: 'OpenID Connect' },
                    { value: 'saml', label: 'SAML 2.0' },
                  ]}
                />
              </Field>
              <Field
                label="Provider ID"
                htmlFor="sso-provider-id"
                hint="Lowercase letters, numbers, and dashes only."
              >
                <Input
                  id="sso-provider-id"
                  value={protocol.providerId}
                  disabled={save.isPending}
                  required
                  maxLength={60}
                  pattern="[a-z0-9-]+"
                  placeholder="company-sso"
                  autoComplete="off"
                  onChange={(event) => setProtocol({ ...protocol, providerId: event.target.value })}
                />
              </Field>
            </section>

            {protocol.kind === 'oidc' ? (
              <OidcFields protocol={protocol} disabled={save.isPending} onChange={setProtocol} />
            ) : (
              <SamlFields protocol={protocol} disabled={save.isPending} onChange={setProtocol} />
            )}
          </>
        )}

        <PolicyFields policy={policy} disabled={save.isPending} onChange={setPolicy} />

        {formError && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-sm text-[var(--danger-on-tint)]"
          >
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add provider'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

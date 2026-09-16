import type { SsoProviderSummary } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RowList } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api, apiErrorMessage } from '~/lib/api-client';

type CopiedEndpoint = 'callback' | 'metadata' | null;

function Endpoint({
  label,
  value,
  copied,
  onCopy,
  openable = false,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  openable?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-1 flex min-w-0 items-center gap-1">
        <code className="min-w-0 flex-1 break-all rounded-md bg-[var(--bg-control)] px-2 py-1.5 text-[0.6875rem] text-[var(--text-secondary)]">
          {value}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={onCopy}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
        {openable && (
          <Button asChild variant="ghost" size="icon-sm">
            <a href={value} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
              <ExternalLink />
            </a>
          </Button>
        )}
      </dd>
    </div>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: SsoProviderSummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<CopiedEndpoint>(null);
  const [copyError, setCopyError] = useState(false);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<{ ok: boolean }>(`/admin/sso/providers/${provider.providerId}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'sso', 'providers'] }),
  });

  async function copy(value: string, endpoint: Exclude<CopiedEndpoint, null>) {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(endpoint);
    } catch {
      setCopied(null);
      setCopyError(true);
    }
  }

  const kindLabel = provider.kind === 'oidc' ? 'OpenID Connect' : 'SAML 2.0';

  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <ShieldCheck className="size-4 text-[var(--accent-bright)]" aria-hidden="true" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-medium text-[var(--text-primary)]">{provider.label}</h2>
            <Badge variant="neutral">{kindLabel}</Badge>
            <Badge variant={provider.enabled ? 'success' : 'warning'}>
              {provider.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <p className="mt-1 break-all text-xs text-[var(--text-muted)]">
            {provider.providerId} · {provider.issuer}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={provider.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
            aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.label}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${provider.label}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${provider.label}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 border-t border-[var(--border-subtle)] pt-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--text-muted)]">JIT provisioning</dt>
          <dd className="mt-0.5 text-xs font-medium text-[var(--text-secondary)]">
            {provider.jitProvisioning ? 'Enabled' : 'Disabled'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Account linking</dt>
          <dd className="mt-0.5 text-xs font-medium text-[var(--text-secondary)]">
            {provider.trustedForLinking ? 'Trusted' : 'Not trusted'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Default role</dt>
          <dd className="mt-0.5 text-xs font-medium capitalize text-[var(--text-secondary)]">
            {provider.defaultRole}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Allowed domains</dt>
          <dd className="mt-0.5 break-words text-xs font-medium text-[var(--text-secondary)]">
            {provider.allowedDomains.length > 0 ? provider.allowedDomains.join(', ') : 'Any domain'}
          </dd>
        </div>
      </dl>

      <div className="mt-4 rounded-xl border border-[var(--accent)]/25 bg-[var(--accent-soft)]/50 p-3 sm:p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          {provider.kind === 'saml' ? 'Service provider details' : 'Application redirect details'}
        </h3>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Configure these exact values in your identity provider.
        </p>
        <dl className="mt-3 grid gap-3">
          <Endpoint
            label={
              provider.kind === 'saml' ? 'Assertion Consumer Service (ACS) URL' : 'Redirect URI'
            }
            value={provider.callbackUrl}
            copied={copied === 'callback'}
            onCopy={() => void copy(provider.callbackUrl, 'callback')}
          />
          {provider.metadataUrl && (
            <Endpoint
              label="SP metadata URL"
              value={provider.metadataUrl}
              copied={copied === 'metadata'}
              onCopy={() => void copy(provider.metadataUrl as string, 'metadata')}
              openable
            />
          )}
        </dl>
        <p className="sr-only" aria-live="polite">
          {copied && `${copied === 'callback' ? 'Callback' : 'Metadata'} URL copied.`}
          {copyError && 'Could not copy the URL. Select it manually.'}
        </p>
      </div>

      {provider.claimRoleMappings.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-[var(--text-muted)]">Role mappings</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {provider.claimRoleMappings.map((mapping) => (
              <Badge
                key={`${mapping.claim}-${mapping.value}-${mapping.role}`}
                variant="outline"
                className="max-w-full font-mono"
              >
                <span className="truncate">
                  {mapping.claim}={mapping.value} → {mapping.role}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {toggle.error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger)]">
          {apiErrorMessage(toggle.error, 'The provider status could not be changed.')}
        </p>
      )}
    </div>
  );
}

export function SsoProviderList({
  providers,
  onEdit,
  onDelete,
}: {
  providers: SsoProviderSummary[];
  onEdit: (provider: SsoProviderSummary) => void;
  onDelete: (provider: SsoProviderSummary) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-muted)]">
        {providers.length} provider{providers.length === 1 ? '' : 's'}
      </p>
      <RowList>
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onEdit={() => onEdit(provider)}
            onDelete={() => onDelete(provider)}
          />
        ))}
      </RowList>
    </div>
  );
}

export function DeleteSsoProviderDialog({
  provider,
  onClose,
}: {
  provider: SsoProviderSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: boolean }>(`/admin/sso/providers/${provider.providerId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'sso', 'providers'] });
      onClose();
    },
  });

  return (
    <DialogContent className="w-[calc(100%-2rem)] max-w-md">
      <DialogHeader>
        <DialogTitle>Delete {provider.label}?</DialogTitle>
        <DialogDescription>
          Users will no longer be able to sign in with this provider. This action cannot be undone.
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3 text-sm text-[var(--text-secondary)]">
        Provider <span className="font-mono">{provider.providerId}</span> and its stored credentials
        will be deleted.
      </div>

      {remove.error && (
        <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
          {apiErrorMessage(remove.error, 'The provider could not be deleted.')}
        </p>
      )}

      <DialogFooter className="flex-col-reverse sm:flex-row">
        <Button type="button" variant="ghost" disabled={remove.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {remove.isPending && <Spinner />}
          {remove.isPending ? 'Deleting…' : 'Delete provider'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

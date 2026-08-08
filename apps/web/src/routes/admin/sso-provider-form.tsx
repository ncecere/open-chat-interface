import {
  type ClaimRoleMapping,
  type CreateSsoProviderInput,
  createSsoProviderSchema,
  type SsoProviderSummary,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { z } from 'zod';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';

/** Both SAML algorithm fields offer the same choices. */
const ALGORITHM_OPTIONS = [
  { value: 'sha256', label: 'SHA-256' },
  { value: 'sha512', label: 'SHA-512' },
] as const;

import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

const policySchema = z.object({
  label: z.string().trim().min(1, 'Enter a display name.').max(80),
  enabled: z.boolean(),
  jitProvisioning: z.boolean(),
  trustedForLinking: z.boolean(),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)),
  defaultRole: z.enum(USER_ROLES),
  claimRoleMappings: z.array(
    z.object({
      claim: z.string().trim().min(1, 'Each role mapping needs a claim.').max(120),
      value: z.string().trim().min(1, 'Each role mapping needs a value.').max(200),
      role: z.enum(USER_ROLES),
    }),
  ),
});

type ProviderKind = SsoProviderSummary['kind'];

interface DraftClaimRoleMapping extends ClaimRoleMapping {
  draftId: string;
}

interface PolicyDraft {
  label: string;
  enabled: boolean;
  jitProvisioning: boolean;
  trustedForLinking: boolean;
  allowedDomains: string;
  defaultRole: UserRole;
  claimRoleMappings: DraftClaimRoleMapping[];
}

interface ProtocolDraft {
  providerId: string;
  kind: ProviderKind;
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  scopes: string;
  pkce: boolean;
  entryPoint: string;
  idpCertificate: string;
  audience: string;
  wantAssertionsSigned: boolean;
  signatureAlgorithm: 'sha256' | 'sha512';
  digestAlgorithm: 'sha256' | 'sha512';
}

const EMPTY_POLICY: PolicyDraft = {
  label: '',
  enabled: true,
  jitProvisioning: true,
  trustedForLinking: false,
  allowedDomains: '',
  defaultRole: 'user',
  claimRoleMappings: [],
};

const EMPTY_PROTOCOL: ProtocolDraft = {
  providerId: '',
  kind: 'oidc',
  issuer: '',
  clientId: '',
  clientSecret: '',
  discoveryUrl: '',
  scopes: 'openid profile email',
  pkce: true,
  entryPoint: '',
  idpCertificate: '',
  audience: '',
  wantAssertionsSigned: true,
  signatureAlgorithm: 'sha256',
  digestAlgorithm: 'sha256',
};

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The SSO provider could not be saved.';
}

function ToggleField({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-6 rounded-lg border border-[var(--border-subtle)] p-3">
      <div>
        <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </label>
        <p id={`${id}-description`} className="mt-1 text-xs text-[var(--text-muted)]">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-description`}
      />
    </div>
  );
}

function RoleMappings({
  mappings,
  disabled,
  onChange,
}: {
  mappings: DraftClaimRoleMapping[];
  disabled: boolean;
  onChange: (mappings: DraftClaimRoleMapping[]) => void;
}) {
  function update(index: number, patch: Partial<ClaimRoleMapping>) {
    onChange(
      mappings.map((mapping, current) => (current === index ? { ...mapping, ...patch } : mapping)),
    );
  }

  return (
    <fieldset className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <legend className="text-sm font-medium text-[var(--text-primary)]">
            Claim-to-role mappings
          </legend>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Assign a role when an exact claim value matches. The default role is used otherwise.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...mappings,
              { draftId: crypto.randomUUID(), claim: '', value: '', role: 'user' },
            ])
          }
        >
          <Plus />
          Add mapping
        </Button>
      </div>

      {mappings.map((mapping, index) => (
        <div
          key={mapping.draftId}
          className="grid gap-2 rounded-lg border border-[var(--border-subtle)] p-3 sm:grid-cols-[1fr_1fr_9rem_auto] sm:items-end"
        >
          <Field label="Claim" htmlFor={`claim-${index}`}>
            <Input
              id={`claim-${index}`}
              value={mapping.claim}
              disabled={disabled}
              maxLength={120}
              placeholder="groups"
              onChange={(event) => update(index, { claim: event.target.value })}
            />
          </Field>
          <Field label="Exact value" htmlFor={`claim-value-${index}`}>
            <Input
              id={`claim-value-${index}`}
              value={mapping.value}
              disabled={disabled}
              maxLength={200}
              placeholder="engineering"
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </Field>
          <Field label="Role" htmlFor={`claim-role-${index}`}>
            <Select
              id={`claim-role-${index}`}
              value={mapping.role}
              disabled={disabled}
              onChange={(next) => update(index, { role: next as UserRole })}
              options={USER_ROLES.map((role) => ({
                value: role,
                label: role.charAt(0).toUpperCase() + role.slice(1),
              }))}
            />
          </Field>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={`Remove mapping ${index + 1}`}
            onClick={() => onChange(mappings.filter((_, current) => current !== index))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </fieldset>
  );
}

function PolicyFields({
  policy,
  disabled,
  onChange,
}: {
  policy: PolicyDraft;
  disabled: boolean;
  onChange: (policy: PolicyDraft) => void;
}) {
  const set = <Key extends keyof PolicyDraft>(key: Key, value: PolicyDraft[Key]) =>
    onChange({ ...policy, [key]: value });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="access-policy-heading">
      <h3 id="access-policy-heading" className="text-sm font-semibold text-[var(--text-primary)]">
        Access policy
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="sso-label" hint="Shown to administrators and users.">
          <Input
            id="sso-label"
            value={policy.label}
            disabled={disabled}
            required
            maxLength={80}
            onChange={(event) => set('label', event.target.value)}
          />
        </Field>
        <Field label="Default role" htmlFor="sso-default-role">
          <Select
            id="sso-default-role"
            value={policy.defaultRole}
            disabled={disabled}
            onChange={(next) => set('defaultRole', next as UserRole)}
            options={USER_ROLES.map((role) => ({
              value: role,
              label: role.charAt(0).toUpperCase() + role.slice(1),
            }))}
          />
        </Field>
      </div>
      <Field
        label="Allowed email domains"
        htmlFor="sso-domains"
        hint="Separate domains with spaces or commas. Leave blank to allow any domain."
      >
        <Input
          id="sso-domains"
          value={policy.allowedDomains}
          disabled={disabled}
          placeholder="example.com, subsidiary.example"
          onChange={(event) => set('allowedDomains', event.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <ToggleField
          id="sso-enabled"
          label="Provider enabled"
          description="Allow this provider to be used for sign-in."
          checked={policy.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => set('enabled', checked)}
        />
        <ToggleField
          id="sso-jit"
          label="Just-in-time provisioning"
          description="Create a user account on the first successful SSO sign-in."
          checked={policy.jitProvisioning}
          disabled={disabled}
          onCheckedChange={(checked) => set('jitProvisioning', checked)}
        />
        <ToggleField
          id="sso-trusted-linking"
          label="Trust for account linking"
          description="Attach this provider to an existing account with the same email. Enable only if this provider verifies email ownership, since otherwise it could be used to take over an account."
          checked={policy.trustedForLinking}
          disabled={disabled}
          onCheckedChange={(checked) => set('trustedForLinking', checked)}
        />
      </div>
      <RoleMappings
        mappings={policy.claimRoleMappings}
        disabled={disabled}
        onChange={(mappings) => set('claimRoleMappings', mappings)}
      />
    </section>
  );
}

function OidcFields({
  protocol,
  disabled,
  onChange,
}: {
  protocol: ProtocolDraft;
  disabled: boolean;
  onChange: (protocol: ProtocolDraft) => void;
}) {
  const set = <Key extends keyof ProtocolDraft>(key: Key, value: ProtocolDraft[Key]) =>
    onChange({ ...protocol, [key]: value });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="oidc-heading">
      <h3 id="oidc-heading" className="text-sm font-semibold text-[var(--text-primary)]">
        OpenID Connect configuration
      </h3>
      <Field label="Issuer URL" htmlFor="oidc-issuer">
        <Input
          id="oidc-issuer"
          type="url"
          value={protocol.issuer}
          disabled={disabled}
          required
          maxLength={500}
          placeholder="https://id.example.com"
          onChange={(event) => set('issuer', event.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID" htmlFor="oidc-client-id">
          <Input
            id="oidc-client-id"
            value={protocol.clientId}
            disabled={disabled}
            required
            maxLength={300}
            autoComplete="off"
            onChange={(event) => set('clientId', event.target.value)}
          />
        </Field>
        <Field
          label="Client secret"
          htmlFor="oidc-client-secret"
          hint="Sent once and never displayed again."
        >
          <Input
            id="oidc-client-secret"
            type="password"
            value={protocol.clientSecret}
            disabled={disabled}
            required
            maxLength={500}
            autoComplete="new-password"
            onChange={(event) => set('clientSecret', event.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Discovery URL (optional)"
        htmlFor="oidc-discovery"
        hint="Defaults to the issuer's /.well-known/openid-configuration endpoint."
      >
        <Input
          id="oidc-discovery"
          type="url"
          value={protocol.discoveryUrl}
          disabled={disabled}
          maxLength={500}
          placeholder="https://id.example.com/.well-known/openid-configuration"
          onChange={(event) => set('discoveryUrl', event.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Scopes" htmlFor="oidc-scopes" hint="Separate scopes with spaces or commas.">
          <Input
            id="oidc-scopes"
            value={protocol.scopes}
            disabled={disabled}
            required
            onChange={(event) => set('scopes', event.target.value)}
          />
        </Field>
        <ToggleField
          id="oidc-pkce"
          label="Use PKCE"
          description="Use Proof Key for Code Exchange for authorization requests."
          checked={protocol.pkce}
          disabled={disabled}
          onCheckedChange={(checked) => set('pkce', checked)}
        />
      </div>
    </section>
  );
}

function SamlFields({
  protocol,
  disabled,
  onChange,
}: {
  protocol: ProtocolDraft;
  disabled: boolean;
  onChange: (protocol: ProtocolDraft) => void;
}) {
  const set = <Key extends keyof ProtocolDraft>(key: Key, value: ProtocolDraft[Key]) =>
    onChange({ ...protocol, [key]: value });

  return (
    <section className="flex flex-col gap-4" aria-labelledby="saml-heading">
      <h3 id="saml-heading" className="text-sm font-semibold text-[var(--text-primary)]">
        SAML 2.0 identity provider
      </h3>
      <Field label="IdP entity ID / issuer" htmlFor="saml-issuer">
        <Input
          id="saml-issuer"
          value={protocol.issuer}
          disabled={disabled}
          required
          maxLength={500}
          placeholder="https://id.example.com/saml/metadata"
          onChange={(event) => set('issuer', event.target.value)}
        />
      </Field>
      <Field label="Single sign-on URL" htmlFor="saml-entry-point">
        <Input
          id="saml-entry-point"
          type="url"
          value={protocol.entryPoint}
          disabled={disabled}
          required
          maxLength={500}
          placeholder="https://id.example.com/saml/sso"
          onChange={(event) => set('entryPoint', event.target.value)}
        />
      </Field>
      <Field
        label="IdP signing certificate"
        htmlFor="saml-certificate"
        hint="Paste the PEM certificate. It is submitted once and is not returned by the API."
      >
        <Textarea
          id="saml-certificate"
          value={protocol.idpCertificate}
          disabled={disabled}
          required
          rows={6}
          maxLength={20000}
          spellCheck={false}
          className="resize-y font-mono text-xs"
          placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
          onChange={(event) => set('idpCertificate', event.target.value)}
        />
      </Field>
      <Field
        label="SP entity ID / audience (optional)"
        htmlFor="saml-audience"
        hint="Defaults to this OCI instance URL."
      >
        <Input
          id="saml-audience"
          value={protocol.audience}
          disabled={disabled}
          maxLength={500}
          placeholder="https://chat.example.com"
          onChange={(event) => set('audience', event.target.value)}
        />
      </Field>
      <ToggleField
        id="saml-signed-assertions"
        label="Require signed assertions"
        description="Reject assertions that are not signed by the configured IdP certificate."
        checked={protocol.wantAssertionsSigned}
        disabled={disabled}
        onCheckedChange={(checked) => set('wantAssertionsSigned', checked)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Signature algorithm" htmlFor="saml-signature-algorithm">
          <Select
            id="saml-signature-algorithm"
            value={protocol.signatureAlgorithm}
            disabled={disabled}
            onChange={(next) => set('signatureAlgorithm', next as 'sha256' | 'sha512')}
            options={ALGORITHM_OPTIONS}
          />
        </Field>
        <Field label="Digest algorithm" htmlFor="saml-digest-algorithm">
          <Select
            id="saml-digest-algorithm"
            value={protocol.digestAlgorithm}
            disabled={disabled}
            onChange={(next) => set('digestAlgorithm', next as 'sha256' | 'sha512')}
            options={ALGORITHM_OPTIONS}
          />
        </Field>
      </div>
    </section>
  );
}

export function SsoProviderForm({
  provider,
  onClose,
}: {
  provider?: SsoProviderSummary;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = Boolean(provider);
  const [policy, setPolicy] = useState<PolicyDraft>(() =>
    provider
      ? {
          label: provider.label,
          enabled: provider.enabled,
          jitProvisioning: provider.jitProvisioning,
          trustedForLinking: provider.trustedForLinking,
          allowedDomains: provider.allowedDomains.join(', '),
          defaultRole: provider.defaultRole,
          claimRoleMappings: provider.claimRoleMappings.map((mapping) => ({
            ...mapping,
            draftId: crypto.randomUUID(),
          })),
        }
      : EMPTY_POLICY,
  );
  const [protocol, setProtocol] = useState<ProtocolDraft>(EMPTY_PROTOCOL);
  const [validationError, setValidationError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (body: CreateSsoProviderInput | z.infer<typeof policySchema>) => {
      if (provider) {
        await api.patch<{ ok: boolean }>(`/admin/sso/providers/${provider.providerId}`, body);
      } else {
        await api.post<{ providerId: string }>('/admin/sso/providers', body);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'sso', 'providers'] });
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError(null);
    save.reset();

    const policyResult = policySchema.safeParse({
      ...policy,
      allowedDomains: splitList(policy.allowedDomains).map((domain) => domain.toLowerCase()),
      claimRoleMappings: policy.claimRoleMappings,
    });
    if (!policyResult.success) {
      setValidationError(policyResult.error.issues[0]?.message ?? 'Check the access policy.');
      return;
    }

    if (provider) {
      save.mutate(policyResult.data);
      return;
    }

    const protocolFields =
      protocol.kind === 'oidc'
        ? {
            kind: 'oidc' as const,
            issuer: protocol.issuer,
            clientId: protocol.clientId,
            clientSecret: protocol.clientSecret,
            discoveryUrl: protocol.discoveryUrl.trim() || null,
            scopes: splitList(protocol.scopes),
            pkce: protocol.pkce,
          }
        : {
            kind: 'saml' as const,
            issuer: protocol.issuer,
            entryPoint: protocol.entryPoint,
            idpCertificate: protocol.idpCertificate,
            audience: protocol.audience.trim() || null,
            wantAssertionsSigned: protocol.wantAssertionsSigned,
            signatureAlgorithm: protocol.signatureAlgorithm,
            digestAlgorithm: protocol.digestAlgorithm,
          };

    const result = createSsoProviderSchema.safeParse({
      ...policyResult.data,
      providerId: protocol.providerId,
      ...protocolFields,
    });
    if (!result.success) {
      setValidationError(result.error.issues[0]?.message ?? 'Check the provider configuration.');
      return;
    }
    save.mutate(result.data);
  }

  const formError = validationError ?? (save.error ? errorMessage(save.error) : null);

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
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-sm text-[var(--danger-foreground)]"
          >
            {formError}
          </p>
        )}

        <DialogFooter className="flex-col-reverse sm:flex-row">
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

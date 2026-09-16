import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import type { ProtocolDraft } from './provider-draft';
import { ToggleField } from './toggle-field';

export function OidcFields({
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

import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import type { ProtocolDraft } from './provider-draft';
import { ToggleField } from './toggle-field';

/** Both SAML algorithm fields offer the same choices. */
const ALGORITHM_OPTIONS = [
  { value: 'sha256', label: 'SHA-256' },
  { value: 'sha512', label: 'SHA-512' },
] as const;

export function SamlFields({
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

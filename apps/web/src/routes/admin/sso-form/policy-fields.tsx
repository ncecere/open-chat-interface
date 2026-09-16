import { USER_ROLES, type UserRole } from '@oci/shared';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import type { PolicyDraft } from './provider-draft';
import { RoleMappings } from './role-mappings';
import { ToggleField } from './toggle-field';

export function PolicyFields({
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

      <ToggleField
        id="sso-require-role"
        label="Require a matching role"
        description="Refuse a sign-in that matches none of the mappings above, instead of granting the default role. Leave this off and every account the provider will authenticate receives access."
        checked={policy.requireRoleMatch}
        disabled={disabled}
        onCheckedChange={(checked) => set('requireRoleMatch', checked)}
      />

      {policy.requireRoleMatch && (
        <Field
          label="Message for a refused sign-in"
          htmlFor="sso-role-message"
          hint="Shown to somebody who authenticated but matched no role. Leave blank for a generic message."
        >
          <Input
            id="sso-role-message"
            value={policy.roleRequiredMessage}
            disabled={disabled}
            maxLength={500}
            placeholder="Request access through the IT service desk."
            onChange={(event) => set('roleRequiredMessage', event.target.value)}
          />
        </Field>
      )}

      <ToggleField
        id="sso-auto-redirect"
        label="Skip the sign-in form"
        description="Send visitors straight to this provider. The form stays reachable at /auth/login?local=1, which is the way back in if the provider fails."
        checked={policy.autoRedirect}
        disabled={disabled}
        onCheckedChange={(checked) => set('autoRedirect', checked)}
      />

      <fieldset className="m-0 border-0 p-0">
        <legend className="font-medium text-sm">Profile claims</legend>
        <p className="mt-1 mb-3 text-[var(--text-muted)] text-xs">
          Leave blank to use the standard claim. Set these only for a provider that names them
          differently.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="sso-claim-email">
            <Input
              id="sso-claim-email"
              value={policy.claimEmail}
              disabled={disabled}
              placeholder="email"
              onChange={(event) => set('claimEmail', event.target.value)}
            />
          </Field>
          <Field label="Display name" htmlFor="sso-claim-name">
            <Input
              id="sso-claim-name"
              value={policy.claimName}
              disabled={disabled}
              placeholder="name"
              onChange={(event) => set('claimName', event.target.value)}
            />
          </Field>
          <Field label="Picture" htmlFor="sso-claim-image">
            <Input
              id="sso-claim-image"
              value={policy.claimImage}
              disabled={disabled}
              placeholder="picture"
              onChange={(event) => set('claimImage', event.target.value)}
            />
          </Field>
          <Field label="Subject" htmlFor="sso-claim-subject">
            <Input
              id="sso-claim-subject"
              value={policy.claimSubject}
              disabled={disabled}
              placeholder="sub"
              onChange={(event) => set('claimSubject', event.target.value)}
            />
          </Field>
        </div>
      </fieldset>
    </section>
  );
}

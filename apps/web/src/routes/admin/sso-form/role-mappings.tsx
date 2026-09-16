import { type ClaimRoleMapping, USER_ROLES, type UserRole } from '@oci/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import type { DraftClaimRoleMapping } from './provider-draft';

export function RoleMappings({
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
          <legend className="font-medium text-[var(--text-primary)] text-sm">
            Group and claim mappings
          </legend>
          <p className="mt-1 max-w-2xl text-[var(--text-muted)] text-xs leading-relaxed">
            Assign a role when a claim carries a value. Group membership usually arrives as a list,
            and a rule matches if any entry does. Use a dotted path such as{' '}
            <code className="rounded bg-black/20 px-1">attributes.groups</code> for a nested claim.
            Matching ignores case. When several rules match, the most privileged role wins, so
            ordering does not matter. The default role applies when nothing matches.
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
          <Field label="Claim or group attribute" htmlFor={`claim-${index}`}>
            <Input
              id={`claim-${index}`}
              value={mapping.claim}
              disabled={disabled}
              maxLength={120}
              placeholder="groups"
              onChange={(event) => update(index, { claim: event.target.value })}
            />
          </Field>
          <Field label="Value to match" htmlFor={`claim-value-${index}`}>
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

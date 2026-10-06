import {
  type RoleAccess,
  STORAGE_POLICY_MAX_FILE_BYTES,
  STORAGE_POLICY_MAX_FILE_COUNT,
  STORAGE_POLICY_MAX_TOTAL_BYTES,
  type StoragePolicy,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';
import { GB, MB, type OptionalLimit, parseOptionalLimit } from '~/routes/admin/lifecycle-shared';
import { invalidateAccess } from './roles-helpers';
import { SavedNote, useSavedFlash } from './saved-note';

interface StoragePolicyDraft {
  maxTotalGb: string;
  maxFileCount: string;
  maxFileMb: string;
  enabled: boolean;
}

function draftFromPolicy(policy: StoragePolicy | null): StoragePolicyDraft {
  return {
    maxTotalGb: policy?.maxTotalBytes ? String(policy.maxTotalBytes / GB) : '',
    maxFileCount: policy?.maxFileCount ? String(policy.maxFileCount) : '',
    maxFileMb: policy?.maxFileBytes ? String(policy.maxFileBytes / MB) : '',
    // Nothing saved enforces nothing, so the switch starts off (#147).
    enabled: policy?.enabled ?? false,
  };
}

const hasLimit = (draft: StoragePolicyDraft) =>
  Boolean(draft.maxTotalGb.trim() || draft.maxFileCount.trim() || draft.maxFileMb.trim());

export function StorageAllowanceForm({ access }: { access: RoleAccess }) {
  const queryClient = useQueryClient();
  const { role, storage } = access;
  const [draft, setDraft] = useState(() => draftFromPolicy(storage));
  // Whether the switch was set by hand; until then, for a role with nothing
  // saved, entering a limit turns enforcement on with it.
  const [switchTouched, setSwitchTouched] = useState(false);
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => {
    setDraft(draftFromPolicy(storage));
    setSwitchTouched(false);
  }, [storage]);

  // Save is offered only for a real change, as in every other section (#147).
  const hasChanges = JSON.stringify(draft) !== JSON.stringify(draftFromPolicy(storage));
  useReportUnsaved(hasChanges);

  // Blank means no limit; anything else has to be a real limit. A 0 or a
  // negative used to be read as blank and saved as unlimited.
  const limits = {
    maxTotalBytes: parseOptionalLimit(draft.maxTotalGb, {
      unit: 'GB',
      scale: GB,
      max: STORAGE_POLICY_MAX_TOTAL_BYTES,
    }),
    maxFileCount: parseOptionalLimit(draft.maxFileCount, {
      unit: 'files',
      max: STORAGE_POLICY_MAX_FILE_COUNT,
      wholeNumber: true,
    }),
    maxFileBytes: parseOptionalLimit(draft.maxFileMb, {
      unit: 'MB',
      scale: MB,
      max: STORAGE_POLICY_MAX_FILE_BYTES,
    }),
  };
  const valid = limits.maxTotalBytes.ok && limits.maxFileCount.ok && limits.maxFileBytes.ok;
  const limitError = (limit: OptionalLimit) => (limit.ok ? undefined : limit.error);
  const limitValue = (limit: OptionalLimit) => (limit.ok ? limit.value : null);

  const save = useMutation({
    // The endpoint replaces the whole record, so every field is sent.
    mutationFn: () =>
      api.put(`/admin/lifecycle/storage-policies/${role}`, {
        role,
        maxTotalBytes: limitValue(limits.maxTotalBytes),
        maxFileCount: limitValue(limits.maxFileCount),
        maxFileBytes: limitValue(limits.maxFileBytes),
        enabled: draft.enabled,
      }),
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function update(patch: Partial<StoragePolicyDraft>) {
    save.reset();
    setSaved(false);
    setDraft((current) => {
      const next = { ...current, ...patch };
      return storage === null && !switchTouched && patch.enabled === undefined
        ? { ...next, enabled: hasLimit(next) }
        : next;
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      // Blank means unlimited and fractional gigabytes are fine, so the
      // browser's step checks would only get in the way.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && hasChanges) save.mutate();
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={`storage-${role}-enabled`} className="font-medium text-sm">
            Enforce allowance
          </label>
          <p className="text-[var(--text-muted)] text-xs">
            {storage === null
              ? 'No allowance is saved for this role, so storage is unlimited.'
              : 'When off, people in this role can store without limit.'}
          </p>
        </div>
        <Switch
          id={`storage-${role}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => {
            setSwitchTouched(true);
            update({ enabled });
          }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Total storage (GB)" htmlFor={`storage-${role}-total`}>
          <Input
            id={`storage-${role}-total`}
            type="number"
            min="0.1"
            step="0.1"
            placeholder="Unlimited"
            value={draft.maxTotalGb}
            aria-invalid={!limits.maxTotalBytes.ok}
            aria-describedby={limits.maxTotalBytes.ok ? undefined : `storage-${role}-total-error`}
            onChange={(event) => update({ maxTotalGb: event.target.value })}
          />
          <FieldError id={`storage-${role}-total-error`} error={limitError(limits.maxTotalBytes)} />
        </Field>
        <Field label="Stored files" htmlFor={`storage-${role}-count`}>
          <Input
            id={`storage-${role}-count`}
            type="number"
            min="1"
            step="1"
            placeholder="Unlimited"
            value={draft.maxFileCount}
            aria-invalid={!limits.maxFileCount.ok}
            aria-describedby={limits.maxFileCount.ok ? undefined : `storage-${role}-count-error`}
            onChange={(event) => update({ maxFileCount: event.target.value })}
          />
          <FieldError id={`storage-${role}-count-error`} error={limitError(limits.maxFileCount)} />
        </Field>
        <Field label="Per file (MB)" htmlFor={`storage-${role}-file`}>
          <Input
            id={`storage-${role}-file`}
            type="number"
            min="1"
            step="1"
            placeholder="Instance default"
            value={draft.maxFileMb}
            aria-invalid={!limits.maxFileBytes.ok}
            aria-describedby={limits.maxFileBytes.ok ? undefined : `storage-${role}-file-error`}
            onChange={(event) => update({ maxFileMb: event.target.value })}
          />
          <FieldError id={`storage-${role}-file-error`} error={limitError(limits.maxFileBytes)} />
        </Field>
      </div>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`The ${role} storage allowance could not be saved.`}
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button
            type="submit"
            variant="primary"
            disabled={!valid || !hasChanges || save.isPending}
          >
            {save.isPending && <Spinner />}
            Save allowance
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

/** A field's validation message, announced when it appears. */
function FieldError({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-[var(--danger)] text-xs">
      {error}
    </p>
  );
}

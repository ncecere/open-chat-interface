import type { RateLimitSettings, RoleAccess } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { ConfigSourceBadge } from '~/components/admin/config-source';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { invalidateAccess, isWholeNumberIn } from './roles-helpers';
import { SavedNote, useSavedFlash } from './saved-note';

const RATE_FIELDS: Array<{ key: keyof RateLimitSettings; label: string; max: number }> = [
  { key: 'maxConcurrentStreams', label: 'Concurrent responses', max: 100 },
  { key: 'chatRequestsPerMinute', label: 'Messages per minute', max: 10_000 },
  { key: 'uploadRequestsPerMinute', label: 'Uploads per minute', max: 10_000 },
];

const RATE_FIELD_IDS: Record<keyof RateLimitSettings, string> = {
  maxConcurrentStreams: 'concurrent',
  chatRequestsPerMinute: 'chat',
  uploadRequestsPerMinute: 'upload',
};

export function RateLimitForm({ access }: { access: RoleAccess }) {
  const queryClient = useQueryClient();
  const { role, rateLimits, rateLimitSources } = access;
  const [draft, setDraft] = useState<Record<keyof RateLimitSettings, string>>(() =>
    draftFromLimits(rateLimits),
  );
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => setDraft(draftFromLimits(rateLimits)), [rateLimits]);

  // Only fields that differ from the stored value are sent, so saving one role
  // never pins another role's (or another field's) inherited value.
  const changes: Partial<RateLimitSettings> = {};
  for (const { key } of RATE_FIELDS) {
    const value = Number(draft[key]);
    if (draft[key].trim() !== '' && value !== rateLimits[key]) changes[key] = value;
  }
  const invalid = RATE_FIELDS.filter(
    ({ key, max }) => !isWholeNumberIn(Number(draft[key]), max) || draft[key].trim() === '',
  );
  const hasChanges = Object.keys(changes).length > 0;
  useReportUnsaved(hasChanges);

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', { roles: { [role]: changes } }),
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges && invalid.length === 0) save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-3">
        {RATE_FIELDS.map(({ key, label, max }) => {
          const id = `rate-${role}-${RATE_FIELD_IDS[key]}`;
          const fieldInvalid = invalid.some((field) => field.key === key);
          return (
            <Field key={key} label={label} htmlFor={id}>
              <Input
                id={id}
                type="number"
                min="1"
                max={max}
                step="1"
                value={draft[key]}
                aria-invalid={fieldInvalid}
                aria-describedby={`${id}-source`}
                onChange={(event) => {
                  save.reset();
                  setSaved(false);
                  setDraft((current) => ({ ...current, [key]: event.target.value }));
                }}
              />
              <ConfigSourceBadge id={`${id}-source`} source={rateLimitSources[key]} />
            </Field>
          );
        })}
      </div>
      {invalid.length > 0 && (
        <p role="alert" className="text-[var(--danger)] text-sm">
          Enter a whole number of 1 or more for{' '}
          {invalid.map((field) => field.label.toLowerCase()).join(', ')}.
        </p>
      )}

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`Rate limits for the ${role} role could not be saved.`}
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button
            type="submit"
            variant="primary"
            disabled={!hasChanges || invalid.length > 0 || save.isPending}
          >
            {save.isPending && <Spinner />}
            Save rate limits
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

function draftFromLimits(limits: RateLimitSettings): Record<keyof RateLimitSettings, string> {
  return {
    maxConcurrentStreams: String(limits.maxConcurrentStreams),
    chatRequestsPerMinute: String(limits.chatRequestsPerMinute),
    uploadRequestsPerMinute: String(limits.uploadRequestsPerMinute),
  };
}

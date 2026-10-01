import { type StoragePolicy, USER_ROLES, type UserRole } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AdminPageHeader,
  LoadError,
  MutationError,
  SettingsSection,
} from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';
import { formatBytes, GB, MB, toNullableNumber } from '~/routes/admin/lifecycle-shared';

interface StoragePolicyDraft {
  maxTotalGb: string;
  maxFileCount: string;
  maxFileMb: string;
  enabled: boolean;
}

function draftFromPolicy(policy: StoragePolicy | undefined): StoragePolicyDraft {
  return {
    maxTotalGb: policy?.maxTotalBytes ? String(policy.maxTotalBytes / GB) : '',
    maxFileCount: policy?.maxFileCount ? String(policy.maxFileCount) : '',
    maxFileMb: policy?.maxFileBytes ? String(policy.maxFileBytes / MB) : '',
    enabled: policy?.enabled ?? true,
  };
}

function StoragePolicyRow({ role, policy }: { role: UserRole; policy: StoragePolicy | undefined }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftFromPolicy(policy));
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(draftFromPolicy(policy)), [policy]);

  const save = useMutation({
    mutationFn: () => {
      const totalGb = toNullableNumber(draft.maxTotalGb);
      const fileMb = toNullableNumber(draft.maxFileMb);

      return api.put(`/admin/lifecycle/storage-policies/${role}`, {
        role,
        maxTotalBytes: totalGb === null ? null : Math.round(totalGb * GB),
        maxFileCount: toNullableNumber(draft.maxFileCount),
        maxFileBytes: fileMb === null ? null : Math.round(fileMb * MB),
        enabled: draft.enabled,
      });
    },
    onSuccess: async () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'storage-policies'] });
    },
  });

  return (
    <div className="border-[var(--border-subtle)] border-b py-5 last:border-0">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium text-sm capitalize">{role}</h3>
        <div className="flex items-center gap-3">
          <label htmlFor={`storage-${role}-enabled`} className="text-[var(--text-muted)] text-xs">
            Enforced
          </label>
          <Switch
            id={`storage-${role}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Total storage (GB)" htmlFor={`storage-${role}-total`}>
          <Input
            id={`storage-${role}-total`}
            type="number"
            min="0.1"
            step="0.1"
            placeholder="Unlimited"
            value={draft.maxTotalGb}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxTotalGb: event.target.value }))
            }
          />
        </Field>

        <Field label="Stored files" htmlFor={`storage-${role}-count`}>
          <Input
            id={`storage-${role}-count`}
            type="number"
            min="1"
            step="1"
            placeholder="Unlimited"
            value={draft.maxFileCount}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxFileCount: event.target.value }))
            }
          />
        </Field>

        <Field label="Per file (MB)" htmlFor={`storage-${role}-file`}>
          <Input
            id={`storage-${role}-file`}
            type="number"
            min="1"
            step="1"
            placeholder="Instance default"
            value={draft.maxFileMb}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxFileMb: event.target.value }))
            }
          />
        </Field>
      </div>

      <div className="mt-3 flex items-center justify-end gap-3">
        <MutationError
          error={save.error}
          message={`The ${role} allowance could not be saved.`}
          className="mr-auto"
        />
        {saved && (
          <span className="flex items-center gap-1.5 text-[var(--success)] text-xs">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Saved
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Spinner />}
          Save {role}
        </Button>
      </div>
    </div>
  );
}

export function AdminStorageLimitsPage() {
  const policies = useQuery({
    queryKey: ['admin', 'storage-policies'],
    queryFn: () => api.get<{ policies: StoragePolicy[] }>('/admin/lifecycle/storage-policies'),
  });

  const health = useQuery({
    queryKey: ['admin', 'storage-health'],
    queryFn: () =>
      api.get<{
        liveBytes: number;
        liveFileCount: number;
        pendingBytes: number;
        pendingFileCount: number;
        pendingDeletions: number;
      }>('/admin/lifecycle/storage-health'),
  });

  const byRole = new Map((policies.data?.policies ?? []).map((policy) => [policy.role, policy]));

  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminPageHeader
        title="Storage limits"
        description="How much each user in a role may store. These are allowances for people; the storage backend itself is configured under Platform → Storage."
      />

      <div className="flex flex-col gap-10 pb-10">
        <SettingsSection
          title="Allowance by role"
          description="Each user in a role gets this much on their own. Leave a field blank for no limit."
        >
          {policies.isLoading ? (
            <Spinner className="mx-auto size-5" />
          ) : policies.isError ? (
            // Rendering the rows anyway would show blank "unlimited" drafts
            // that overwrite the real allowances if saved.
            <LoadError title="Storage allowances could not be loaded." query={policies} />
          ) : (
            <div>
              {USER_ROLES.map((role) => (
                <StoragePolicyRow key={role} role={role} policy={byRole.get(role)} />
              ))}
            </div>
          )}
        </SettingsSection>

        <SettingsSection
          title="Storage in use"
          description="Deleted files still occupy disk until their trash window elapses and cleanup removes them."
        >
          {health.isError && (
            <LoadError title="Storage usage could not be loaded." query={health} />
          )}
          {health.isLoading && <Spinner className="mx-auto size-5" />}
          {health.data && (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-[var(--text-muted)] text-xs">In use</dt>
                <dd className="mt-1 font-semibold text-lg">{formatBytes(health.data.liveBytes)}</dd>
                <p className="text-[var(--text-muted)] text-xs">
                  {health.data.liveFileCount.toLocaleString()} files
                </p>
              </div>
              <div>
                <dt className="text-[var(--text-muted)] text-xs">Pending deletion</dt>
                <dd className="mt-1 font-semibold text-lg">
                  {formatBytes(health.data.pendingBytes)}
                </dd>
                <p className="text-[var(--text-muted)] text-xs">
                  {health.data.pendingFileCount.toLocaleString()} files in trash
                </p>
              </div>
              <div>
                <dt className="text-[var(--text-muted)] text-xs">Objects queued for removal</dt>
                <dd className="mt-1 font-semibold text-lg">
                  {health.data.pendingDeletions.toLocaleString()}
                </dd>
                <p className="text-[var(--text-muted)] text-xs">Cleared by the cleanup job</p>
              </div>
            </dl>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}

import {
  type JobRun,
  MIN_TRASH_RETENTION_DAYS,
  type RateLimitSettings,
  type RetentionSettings,
  type StoragePolicy,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { AdminPageHeader, Notice, SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Blank means unlimited for that dimension, which the inputs express as empty. */
function toNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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
        {saved && (
          <span className="flex items-center gap-1.5 text-[var(--success)] text-xs">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Saved
          </span>
        )}
        {/* Explicitly not a submit: the shared Button defaults to submit, and
            these rows render alongside the retention form. */}
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

function RetentionForm({ settings }: { settings: RetentionSettings }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const save = useMutation({
    mutationFn: () => api.put<RetentionSettings>('/admin/lifecycle/retention', draft),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'retention'] });
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'Retention could not be saved.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Trash retention (days)"
          htmlFor="trash-days"
          hint="How long a deleted conversation stays restorable before it is destroyed."
        >
          <Input
            id="trash-days"
            type="number"
            min={MIN_TRASH_RETENTION_DAYS}
            max="365"
            value={draft.trashRetentionDays}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                trashRetentionDays: Number(event.target.value),
              }))
            }
          />
        </Field>

        <Field
          label="Conversation retention (days)"
          htmlFor="thread-days"
          hint="Inactive conversations move to trash after this long. Leave blank to keep them forever."
        >
          <Input
            id="thread-days"
            type="number"
            min="1"
            placeholder="Never"
            value={draft.threadRetentionDays ?? ''}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                threadRetentionDays: event.target.value ? Number(event.target.value) : null,
              }))
            }
          />
        </Field>

        <Field
          label="Usage history (days)"
          htmlFor="usage-days"
          hint="Per-message usage rows. Daily totals are kept regardless."
        >
          <Input
            id="usage-days"
            type="number"
            min="1"
            value={draft.usageEventRetentionDays}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                usageEventRetentionDays: Number(event.target.value),
              }))
            }
          />
        </Field>

        <Field
          label="Audit log (days)"
          htmlFor="audit-days"
          hint="Security-relevant entries such as role and credential changes are kept regardless."
        >
          <Input
            id="audit-days"
            type="number"
            min="1"
            value={draft.auditLogRetentionDays}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                auditLogRetentionDays: Number(event.target.value),
              }))
            }
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
        <div>
          <label htmlFor="exempt-pinned" className="font-medium text-sm">
            Keep pinned conversations
          </label>
          <p className="mt-0.5 text-[var(--text-muted)] text-xs">
            Pinned conversations are never removed automatically. The user marked them deliberately.
          </p>
        </div>
        <Switch
          id="exempt-pinned"
          checked={draft.exemptPinnedThreads}
          onCheckedChange={(exemptPinnedThreads) =>
            setDraft((current) => ({ ...current, exemptPinnedThreads }))
          }
        />
      </div>

      {draft.threadRetentionDays !== null && (
        <Notice tone="warning" title="Conversations will be removed automatically">
          Conversations with no activity for {draft.threadRetentionDays} days move to the trash,
          then are destroyed {draft.trashRetentionDays} days later. Shared conversations are not
          exempt, so their links stop working when they are removed.
        </Notice>
      )}

      <div className="flex items-center justify-end gap-3">
        {error && (
          <p role="alert" className="mr-auto text-[var(--danger)] text-sm">
            {error}
          </p>
        )}
        {saved && (
          <span className="mr-auto flex items-center gap-1.5 text-[var(--success)] text-sm">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Saved
          </span>
        )}
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending && <Spinner />}
          Save retention
        </Button>
      </div>
    </form>
  );
}

function RateLimitForm({
  settings,
}: {
  settings: { roles: Record<UserRole, RateLimitSettings>; authAttemptsPerMinute: number };
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', draft),
    onSuccess: async () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'rate-limits'] });
    },
  });

  function update(role: UserRole, key: keyof RateLimitSettings, value: number) {
    setDraft((current) => ({
      ...current,
      roles: { ...current.roles, [role]: { ...current.roles[role], [key]: value } },
    }));
  }

  return (
    <div className="flex flex-col gap-5">
      {USER_ROLES.map((role) => (
        <div key={role} className="border-[var(--border-subtle)] border-b pb-5 last:border-0">
          <h3 className="font-medium text-sm capitalize">{role}</h3>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field
              label="Concurrent responses"
              htmlFor={`rate-${role}-concurrent`}
              hint="How many generations may run at once."
            >
              <Input
                id={`rate-${role}-concurrent`}
                type="number"
                min="1"
                value={draft.roles[role].maxConcurrentStreams}
                onChange={(event) =>
                  update(role, 'maxConcurrentStreams', Number(event.target.value))
                }
              />
            </Field>

            <Field label="Messages per minute" htmlFor={`rate-${role}-chat`}>
              <Input
                id={`rate-${role}-chat`}
                type="number"
                min="1"
                value={draft.roles[role].chatRequestsPerMinute}
                onChange={(event) =>
                  update(role, 'chatRequestsPerMinute', Number(event.target.value))
                }
              />
            </Field>

            <Field label="Uploads per minute" htmlFor={`rate-${role}-upload`}>
              <Input
                id={`rate-${role}-upload`}
                type="number"
                min="1"
                value={draft.roles[role].uploadRequestsPerMinute}
                onChange={(event) =>
                  update(role, 'uploadRequestsPerMinute', Number(event.target.value))
                }
              />
            </Field>
          </div>
        </div>
      ))}

      <Field
        label="Sign-in attempts per minute"
        htmlFor="rate-auth"
        hint="Counted per IP address and per account, so neither can be varied to evade the limit."
      >
        <Input
          id="rate-auth"
          type="number"
          min="1"
          className="sm:max-w-48"
          value={draft.authAttemptsPerMinute}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              authAttemptsPerMinute: Number(event.target.value),
            }))
          }
        />
      </Field>

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="mr-auto flex items-center gap-1.5 text-[var(--success)] text-sm">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            Saved
          </span>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Spinner />}
          Save limits
        </Button>
      </div>
    </div>
  );
}

function JobHealth() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => api.get<{ runs: JobRun[] }>('/admin/lifecycle/jobs'),
    refetchInterval: 30_000,
  });

  const run = useMutation({
    mutationFn: (name: string) => api.post(`/admin/lifecycle/jobs/${name}/run`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
  });

  // One row per job, showing only its most recent run.
  const latest = new Map<string, JobRun>();
  for (const entry of data?.runs ?? []) {
    if (!latest.has(entry.jobName)) latest.set(entry.jobName, entry);
  }
  const runs = [...latest.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));

  if (runs.length === 0) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        No maintenance has run yet. Jobs start on their own schedule after the API boots.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
      {runs.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center gap-3 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
        >
          {entry.status === 'error' ? (
            <AlertTriangle className="size-4 shrink-0 text-[var(--danger)]" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm">{entry.jobName}</p>
            <p className="truncate text-[var(--text-muted)] text-xs">
              {new Date(entry.startedAt).toLocaleString()} · {entry.itemsProcessed} item
              {entry.itemsProcessed === 1 ? '' : 's'}
              {entry.errorMessage ? ` · ${entry.errorMessage}` : ''}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Run ${entry.jobName} now`}
            disabled={run.isPending}
            onClick={() => run.mutate(entry.jobName)}
          >
            <RefreshCw />
          </Button>
        </div>
      ))}
    </div>
  );
}

export function AdminLifecyclePage() {
  const policies = useQuery({
    queryKey: ['admin', 'storage-policies'],
    queryFn: () => api.get<{ policies: StoragePolicy[] }>('/admin/lifecycle/storage-policies'),
  });

  const retention = useQuery({
    queryKey: ['admin', 'retention'],
    queryFn: () => api.get<RetentionSettings>('/admin/lifecycle/retention'),
  });

  const rateLimits = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: () =>
      api.get<{ roles: Record<UserRole, RateLimitSettings>; authAttemptsPerMinute: number }>(
        '/admin/lifecycle/rate-limits',
      ),
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
    <div className="flex flex-col gap-10">
      <AdminPageHeader
        title="Storage & retention"
        description="Storage allowances apply per user within a role. Retention decides how long conversations and history are kept, and everything deleted goes to a recoverable trash first."
      />

      <SettingsSection
        title="Storage allowance"
        description="Each user in a role gets this much on their own. Leave a field blank for no limit."
      >
        {policies.isLoading ? (
          <Spinner className="mx-auto size-5" />
        ) : (
          <div>
            {USER_ROLES.map((role) => (
              <StoragePolicyRow key={role} role={role} policy={byRole.get(role)} />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Retention"
        description="Automatic cleanup keeps the database and object storage bounded."
      >
        {retention.data ? (
          <RetentionForm settings={retention.data} />
        ) : (
          <Spinner className="size-5" />
        )}
      </SettingsSection>

      <SettingsSection
        title="Rate & concurrency limits"
        description="A quota bounds how much is used over a window. These bound how fast requests arrive and how many generations run at once."
      >
        {rateLimits.data ? (
          <RateLimitForm settings={rateLimits.data} />
        ) : (
          <Spinner className="size-5" />
        )}
      </SettingsSection>

      <SettingsSection
        title="Storage in use"
        description="Deleted files still occupy disk until their trash window elapses and the cleanup job removes them."
      >
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

      <SettingsSection
        title="Maintenance"
        description="The most recent run of each background job. Only one replica runs a given job at a time."
      >
        <JobHealth />
      </SettingsSection>
    </div>
  );
}

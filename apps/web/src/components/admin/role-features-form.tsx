import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  ROLE_FEATURE_KEYS,
  type RoleAccess,
  type RoleFeatureKey,
  type UpdateRoleFeaturesInput,
} from '@oci/shared';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';

type RoleFeatures = RoleAccess['roleFeatures'];

const ROLE_FEATURE_LABELS: Record<RoleFeatureKey, { label: string; description: string }> = {
  webSearch: {
    label: 'Web search',
    description: 'Ground answers in current web results from the configured provider.',
  },
  attachments: {
    label: 'File attachments',
    description: 'Upload files and attach them to messages.',
  },
  shareLinks: {
    label: 'Share links',
    description: 'Create public links to their conversations.',
  },
  temporaryChat: {
    label: 'Temporary chats',
    description: 'Start chats that are deleted after 24 hours and kept out of history.',
  },
  branching: {
    label: 'Branching',
    description: 'Fork a conversation or edit an earlier message into a new branch.',
  },
  projects: {
    label: 'Projects',
    description:
      'Group conversations under shared instructions and files. Project files also need file attachments. There is no instance-wide switch.',
  },
  memory: {
    label: 'User memory',
    description:
      'Opt in to notes about themselves that are included in their conversations and that models with tools can save. Needs the instance-wide switch; each person still switches it on.',
  },
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function sameEfforts(a: readonly ReasoningEffort[], b: readonly ReasoningEffort[]): boolean {
  return a.length === b.length && a.every((effort, index) => effort === b[index]);
}

/**
 * Only fields that differ from what is saved, so one change never pins another
 * field's inherited default. Exported for tests.
 */
function roleFeatureChanges(saved: RoleFeatures, draft: RoleFeatures): UpdateRoleFeaturesInput {
  const changes: UpdateRoleFeaturesInput = {};
  for (const key of ROLE_FEATURE_KEYS) {
    if (draft[key] !== saved[key]) changes[key] = draft[key];
  }
  if (!sameEfforts(draft.reasoningEfforts, saved.reasoningEfforts)) {
    changes.reasoningEfforts = [...draft.reasoningEfforts];
  }
  return changes;
}

/**
 * A role's feature switches and allowed reasoning levels.
 *
 * A switch here can only narrow what the instance offers: the instance-wide
 * switches on General settings and Web search still apply to everyone.
 */
export function RoleFeaturesForm({
  access,
  roleLabel,
  onSaved,
}: {
  access: RoleAccess;
  roleLabel: string;
  onSaved: () => Promise<unknown>;
}) {
  const { role, roleFeatures: saved, features: effective } = access;
  const [draft, setDraft] = useState<RoleFeatures>(saved);
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => setDraft(saved), [saved]);
  useEffect(() => {
    if (!showSaved) return;
    const timer = setTimeout(() => setShowSaved(false), 2_500);
    return () => clearTimeout(timer);
  }, [showSaved]);

  const changes = roleFeatureChanges(saved, draft);
  const hasChanges = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => api.put(`/admin/roles/${role}`, changes),
    onSuccess: async () => {
      setShowSaved(true);
      await onSaved();
    },
  });

  function update(patch: Partial<RoleFeatures>) {
    save.reset();
    setShowSaved(false);
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleEffort(effort: ReasoningEffort, on: boolean) {
    const next = new Set(draft.reasoningEfforts);
    if (on) next.add(effort);
    else next.delete(effort);
    // Canonical order, with instant always present, matches what the server stores.
    update({
      reasoningEfforts: REASONING_EFFORTS.filter((level) => level === 'instant' || next.has(level)),
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges) save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <p className="text-[var(--text-muted)] text-xs">
        These switches narrow what the instance offers to the {roleLabel} role. Instance-wide
        switches live on{' '}
        <Link
          to="/admin/settings/general"
          className="text-[var(--accent-bright)] underline underline-offset-2"
        >
          General settings
        </Link>{' '}
        and{' '}
        <Link
          to="/admin/search"
          className="text-[var(--accent-bright)] underline underline-offset-2"
        >
          Web search
        </Link>
        ; a feature switched off there stays off for everyone.
      </p>

      <div className="divide-y divide-[var(--border-subtle)]">
        {ROLE_FEATURE_KEYS.map((key) => {
          const id = `role-${role}-feature-${key}`;
          // Saved on for the role yet unavailable: the instance switch is off.
          const blocked = saved[key] && !effective[key];
          return (
            <div key={key} className="flex items-start justify-between gap-6 py-4 first:pt-0">
              <div className="min-w-0">
                <label htmlFor={id} className="font-medium text-sm">
                  {ROLE_FEATURE_LABELS[key].label}
                </label>
                <p id={`${id}-description`} className="mt-1 text-[var(--text-muted)] text-xs">
                  {ROLE_FEATURE_LABELS[key].description}
                  {blocked && (
                    <span className="mt-1 block text-[var(--warning)]">
                      {key === 'webSearch'
                        ? 'Unavailable until web search is switched on and configured instance-wide.'
                        : 'Switched off instance-wide, so unavailable to everyone.'}
                    </span>
                  )}
                </p>
              </div>
              <Switch
                id={id}
                className="mt-0.5"
                checked={draft[key]}
                aria-describedby={`${id}-description`}
                onCheckedChange={(checked) => update({ [key]: checked })}
              />
            </div>
          );
        })}
      </div>

      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="font-medium text-sm">Reasoning levels</legend>
        <p className="mt-1 text-[var(--text-muted)] text-xs">
          Levels this role may choose, on models that offer them. Instant is always available.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {REASONING_EFFORTS.map((effort) => {
            const id = `role-${role}-effort-${effort}`;
            const always = effort === 'instant';
            return (
              <label key={effort} htmlFor={id} className="flex items-center gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={always || draft.reasoningEfforts.includes(effort)}
                  disabled={always}
                  onChange={(event) => toggleEffort(effort, event.target.checked)}
                />
                {EFFORT_LABELS[effort]}
              </label>
            );
          })}
        </div>
      </fieldset>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`Features for the ${role} role could not be saved.`}
            className="mr-auto"
          />
          {showSaved && (
            <span className="flex items-center gap-1.5 text-[var(--success)] text-sm">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
            {save.isPending && <Spinner />}
            Save features
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

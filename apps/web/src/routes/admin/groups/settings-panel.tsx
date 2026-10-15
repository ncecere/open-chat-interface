import {
  type AdminGroup,
  type AdminGroupDetail,
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_ERROR_REASONS,
  GROUP_NAME_MAX_LENGTH,
  type UpdateGroupInput,
  updateGroupSchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { EditableFieldset, EditOnly } from '~/components/admin/admin-access';
import { SaveRow } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api } from '~/lib/api-client';
import {
  ADMIN_GROUPS_KEY,
  describeGroupError,
  GROUP_FIELD_LABELS,
  groupErrorReason,
} from '~/lib/groups';
import { plural } from '~/lib/utils';
import { validationProblems } from '~/lib/validation-issues';

/** What deleting removes, from the counts the group holds now, as a sentence. */
export function deletionConsequences(group: AdminGroupDetail): string {
  const parts = [
    group.memberCount > 0 && plural(group.memberCount, 'member'),
    group.policyCount > 0 && plural(group.policyCount, 'budget'),
    group.modelCount > 0 && plural(group.modelCount, 'model'),
    group.sharedProjectCount > 0 && plural(group.sharedProjectCount, 'shared project'),
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return 'It has no members, budgets, models or shared projects.';
  return `This removes its ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}: the people lose the budgets and models it gave them, and projects shared with it stop being shared with them. Nobody’s account, role or conversations are deleted.`;
}

function RenameForm({ group }: { group: AdminGroupDetail }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [saved, setSaved] = useState(false);
  const [problems, setProblems] = useFieldProblems({ name, description });
  const at = (field: string) => problemsAt(problems, field);
  const formError = problemsElsewhere(problems, ['name', 'description']);

  // Only what differs from what is saved is sent.
  const changes: UpdateGroupInput = {};
  if (name.trim() !== group.name) changes.name = name;
  if (description.trim() !== (group.description ?? ''))
    changes.description = description.trim() === '' ? null : description;
  const dirty = Object.keys(changes).length > 0;
  useReportUnsaved(dirty);

  const save = useMutation({
    mutationFn: (body: UpdateGroupInput) =>
      api.patch<AdminGroup>(`/admin/groups/${group.id}`, body),
    onSuccess: async (updated) => {
      setName(updated.name);
      setDescription(updated.description ?? '');
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY });
    },
    onError: (error) => {
      const field = groupErrorReason(error) === GROUP_ERROR_REASONS.NAME_TAKEN ? ['name'] : [];
      setProblems([
        { fields: field, text: describeGroupError(error, 'The group could not be saved.') },
      ]);
    },
  });

  // Editing anything puts the "Saved." note away (the handlers above): it is about the earlier values.
  const savedNote = saved ? 'Saved.' : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblems([]);
    setSaved(false);
    if (!dirty) return;
    const result = updateGroupSchema.safeParse(changes);
    if (!result.success) {
      setProblems(
        validationProblems(result.error.issues, GROUP_FIELD_LABELS).map(({ field, text }) => ({
          fields: field ? [field] : [],
          text,
        })),
      );
      return;
    }
    save.mutate(result.data);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-4">
      <EditableFieldset className="flex flex-col gap-4">
        <Field label="Name" htmlFor="group-settings-name" error={at('name')}>
          <Input
            id="group-settings-name"
            {...invalidFieldProps('group-settings-name', at('name'))}
            value={name}
            maxLength={GROUP_NAME_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="group-settings-description"
          hint="What the group is for. Only administrators and the group’s managers see it."
          error={at('description')}
        >
          <Textarea
            id="group-settings-description"
            {...invalidFieldProps('group-settings-description', at('description'))}
            rows={3}
            value={description}
            maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => {
              setDescription(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
      </EditableFieldset>
      <SaveRow
        hasChanges={dirty}
        isPending={save.isPending}
        errorMessage={formError}
        successMessage={savedNote}
        subject="the group"
      />
    </form>
  );
}

/** Settings tab: rename, describe, and delete with what goes. */
export function SettingsPanel({
  group,
  refetch,
}: {
  group: AdminGroupDetail;
  /** Reads the counts again, so the dialog states what is true when it opens. */
  refetch: () => unknown;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex flex-col gap-10">
      <RenameForm group={group} />

      <EditOnly>
        <section aria-labelledby="delete-group-heading">
          <h2 id="delete-group-heading" className="font-semibold text-base">
            Delete group
          </h2>
          <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[var(--text-muted)] text-sm">
              Permanently delete this group. Its members keep their accounts.
            </p>
            <Button
              type="button"
              size="sm"
              variant="danger"
              className="shrink-0"
              onClick={() => {
                void refetch();
                setDeleting(true);
              }}
            >
              Delete group
            </Button>
          </div>
        </section>

        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${group.name}?`}
          description={<>{deletionConsequences(group)} This cannot be undone.</>}
          confirmLabel="Delete group"
          pendingLabel="Deleting…"
          errorMessage="The group could not be deleted."
          onConfirm={async () => {
            await api.delete(`/admin/groups/${group.id}`);
            await navigate({ to: '/admin/groups' });
            queryClient.removeQueries({ queryKey: [...ADMIN_GROUPS_KEY, 'detail', group.id] });
            await queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY });
          }}
        />
      </EditOnly>
    </div>
  );
}

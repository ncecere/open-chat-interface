import {
  type AdminGroup,
  createGroupSchema,
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_ERROR_REASONS,
  GROUP_NAME_MAX_LENGTH,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useEditedSince } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api } from '~/lib/api-client';
import {
  ADMIN_GROUPS_KEY,
  describeGroupError,
  GROUP_FIELD_LABELS,
  groupErrorReason,
} from '~/lib/groups';
import { validationProblems } from '~/lib/validation-issues';

/** New group: a name, and optionally what the group is for. Opens on the new group's page. */
export function CreateGroupDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const changed = useEditedSince({ name, description });
  const [problems, setProblems] = useFieldProblems({ name, description });
  const at = (field: string) => problemsAt(problems, field);
  const formError = problemsElsewhere(problems, ['name', 'description']);

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string | null }) =>
      api.post<AdminGroup>('/admin/groups', body),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY });
      onClose();
      await navigate({ to: '/admin/groups/$groupId', params: { groupId: created.id } });
    },
    onError: (error) => {
      // A name in use is about the Name field; a limit is about the attempt.
      const field = groupErrorReason(error) === GROUP_ERROR_REASONS.NAME_TAKEN ? ['name'] : [];
      setProblems([
        { fields: field, text: describeGroupError(error, 'The group could not be created.') },
      ]);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblems([]);
    const body = { name, description: description.trim() === '' ? null : description };
    const result = createGroupSchema.safeParse(body);
    if (!result.success) {
      setProblems(
        validationProblems(result.error.issues, GROUP_FIELD_LABELS).map(({ field, text }) => ({
          fields: field ? [field] : [],
          text,
        })),
      );
      return;
    }
    create.mutate(result.data);
  }

  return (
    <DialogContent className="w-[calc(100%-2rem)]" confirmDiscard={changed}>
      <DialogHeader>
        <DialogTitle>New group</DialogTitle>
        <DialogDescription>
          Name a set of people, such as a department. Then add its members and choose the budgets
          and models it gives them.
        </DialogDescription>
      </DialogHeader>

      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Name" htmlFor="group-name" error={at('name')}>
          <Input
            id="group-name"
            {...invalidFieldProps('group-name', at('name'))}
            value={name}
            maxLength={GROUP_NAME_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label="Description (optional)"
          htmlFor="group-description"
          hint="What the group is for. Only administrators and the group's managers see it."
          error={at('description')}
        >
          <Textarea
            id="group-description"
            {...invalidFieldProps('group-description', at('description'))}
            rows={3}
            value={description}
            maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        {formError && (
          <p
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
            role="alert"
          >
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Create group
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

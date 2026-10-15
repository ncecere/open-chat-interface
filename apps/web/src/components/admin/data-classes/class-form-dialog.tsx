import {
  type AdminDataClass,
  createDataClassSchema,
  DATA_CLASS_DESCRIPTION_MAX_LENGTH,
  DATA_CLASS_NAME_MAX_LENGTH,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { ADMIN_DATA_CLASSES_KEY } from '~/components/admin/data-class-select';
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
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';
import { validationProblems } from '~/lib/validation-issues';

const LABELS = { name: 'Name', description: 'Description' };

/**
 * Adds a data class, or renames and re-describes one. A rename keeps the
 * class's id, so every label and approval follows it (#395).
 */
export function ClassFormDialog({
  dataClass,
  onClose,
}: {
  dataClass: AdminDataClass | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(dataClass?.name ?? '');
  const [description, setDescription] = useState(dataClass?.description ?? '');
  const values = { name, description };
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems(values, form);
  const edited = useEditedSince(values);
  const at = (field: keyof typeof values) => problemsAt(problems, field);
  const error = problemsElsewhere(problems, ['name', 'description']);

  const save = useMutation({
    mutationFn: (body: { name: string; description: string }) =>
      dataClass
        ? api.patch(`/admin/data-classes/${dataClass.id}`, body)
        : api.post('/admin/data-classes', body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ADMIN_DATA_CLASSES_KEY });
      onClose();
    },
    onError: (cause) =>
      setProblems(apiErrorProblems(cause, 'The data class could not be saved.', LABELS)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);
    const parsed = createDataClassSchema.safeParse({ name, description });
    if (!parsed.success) {
      const found: FieldProblem[] = validationProblems(parsed.error.issues, LABELS).map(
        ({ field, text }) => ({ fields: field ? [field] : [], text }),
      );
      setProblems(found.length > 0 ? found : [{ fields: [], text: 'Check the data class.' }]);
      return;
    }
    if (
      dataClass &&
      parsed.data.name === dataClass.name &&
      parsed.data.description === dataClass.description
    ) {
      onClose();
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{dataClass ? `Rename ${dataClass.name}` : 'Add data class'}</DialogTitle>
        <DialogDescription>
          {dataClass
            ? 'Renaming changes the name everywhere at once: labels and approvals stay with the class.'
            : 'A named kind of data, such as “Student records”. People see the name in their own conversations, so use words they know.'}
        </DialogDescription>
      </DialogHeader>
      <form ref={form} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" htmlFor="data-class-name" error={at('name')}>
          <Input
            id="data-class-name"
            {...invalidFieldProps('data-class-name', at('name'))}
            value={name}
            maxLength={DATA_CLASS_NAME_MAX_LENGTH}
            autoComplete="off"
            placeholder="Student records"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Description (optional)"
          htmlFor="data-class-description"
          hint="For administrators: what belongs in this class."
          error={at('description')}
        >
          <Textarea
            id="data-class-description"
            {...invalidFieldProps('data-class-description', at('description'))}
            rows={3}
            value={description}
            maxLength={DATA_CLASS_DESCRIPTION_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        {error && (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {dataClass ? 'Save changes' : 'Add data class'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

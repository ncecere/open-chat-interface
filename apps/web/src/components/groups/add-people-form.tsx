import {
  type AddGroupMembersResult,
  addGroupMembersSchema,
  GROUP_MEMBER_ROLES,
  type GroupMemberRoleName,
  MAX_EMAILS_PER_ADD,
  managerAddGroupMembersSchema,
} from '@oci/shared';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { z } from 'zod';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api } from '~/lib/api-client';
import { type AddOutcome, describeAddResult, GROUP_FIELD_LABELS, parseEmails } from '~/lib/groups';
import { formatList, type Translate, useT } from '~/lib/i18n';
import { validationProblems } from '~/lib/validation-issues';

const roleOptions = (t: Translate) =>
  GROUP_MEMBER_ROLES.map((role) => ({
    value: role,
    label: role === 'manager' ? t('groups.role.manager') : t('groups.role.member'),
  }));

/** One address is an email address by the same rule the server applies. */
const isEmail = (value: string) => z.string().email().max(320).safeParse(value).success;

/**
 * Add people to a group by email, shared by the administrator's group page
 * (with a role to choose) and a manager's Settings page (members only). Every
 * address lands in one list of the result, and the status line says which:
 * the ones with no account stay in the box so a typo can be corrected, the
 * rest are done. A refusal stays at the form, in words from `describeError`.
 */
export function AddPeopleForm({
  path,
  withRole,
  describeError,
  onAdded,
}: {
  /** The API path that takes `POST { emails, role? }`. */
  path: string;
  withRole: boolean;
  describeError: (error: unknown) => string;
  /** Runs after a request the server accepted, so the page can read the group again. */
  onAdded: (result: AddGroupMembersResult) => unknown;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [role, setRole] = useState<GroupMemberRoleName>('member');
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [problems, setProblems] = useFieldProblems({ text, role });
  const error = problemsAt(problems, 'text');
  const elsewhere = problems.find((problem) => problem.fields.length === 0)?.text ?? null;

  const add = useMutation({
    mutationFn: (body: { emails: string[]; role?: GroupMemberRoleName }) =>
      api.post<AddGroupMembersResult>(path, body),
    onSuccess: async (result) => {
      setOutcome(describeAddResult(result));
      setText(result.unknown.join('\n'));
      await onAdded(result);
    },
    onError: (failure) => setProblems([{ fields: [], text: describeError(failure) }]),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblems([]);
    setOutcome(null);
    const entries = parseEmails(text);
    const invalid = entries.filter((entry) => !isEmail(entry));
    if (invalid.length > 0) {
      setProblems([
        {
          fields: ['text'],
          text: t('groups.add.notAnEmail', { emails: formatList(invalid) }),
        },
      ]);
      return;
    }
    const result = withRole
      ? addGroupMembersSchema.safeParse({ emails: entries, role })
      : managerAddGroupMembersSchema.safeParse({ emails: entries });
    if (!result.success) {
      setProblems(
        validationProblems(result.error.issues, GROUP_FIELD_LABELS).map(({ text: sentence }) => ({
          fields: ['text'],
          text: sentence,
        })),
      );
      return;
    }
    add.mutate(result.data);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Field
        label={t('groups.add.label')}
        htmlFor="member-emails"
        hint={t('groups.add.hint', { max: MAX_EMAILS_PER_ADD })}
        error={error}
      >
        <Textarea
          id="member-emails"
          {...invalidFieldProps('member-emails', error)}
          rows={3}
          value={text}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-end gap-3">
        {withRole && (
          <div className="w-44">
            <Field label={t('groups.add.roleLabel')} htmlFor="member-role">
              <Select
                id="member-role"
                aria-label={t('groups.add.roleLabel')}
                value={role}
                onChange={(next) => setRole(next as GroupMemberRoleName)}
                options={roleOptions(t)}
              />
            </Field>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending && <Spinner />}
          {t('groups.add.submit')}
        </Button>
      </div>

      {elsewhere && (
        <p
          role="alert"
          className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {elsewhere}
        </p>
      )}

      <div data-testid="add-outcome" role="status" className="text-sm">
        {outcome && (
          <>
            <p className="text-[var(--text-secondary)]">{outcome.summary}</p>
            {outcome.problems.map((entry) => (
              <p key={entry.label} className="mt-1 text-xs text-[var(--text-muted)]">
                <span className="font-medium">{entry.label}:</span> {entry.emails.join(', ')}
              </p>
            ))}
          </>
        )}
      </div>
    </form>
  );
}

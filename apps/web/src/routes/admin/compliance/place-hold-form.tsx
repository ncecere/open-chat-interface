import type { LegalHold } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileLock } from 'lucide-react';
import { useState } from 'react';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { ADMIN_USERS_QUERY_KEY } from '~/components/admin/user-role-select';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { ApiError, api, apiErrorProblems } from '~/lib/api-client';
import { COMPLIANCE_QUERY_KEY } from './query-key';

/** Places a legal hold on one person, found by their email address. */
export function PlaceHoldForm() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  // A hold half placed is asked about before leaving (#300's sweep).
  useReportUnsaved(Boolean(email.trim() || reason.trim()));
  // "No account has that address" is about the address, so it is shown at
  // it, and goes once it is edited (#217, #317's sweep).
  const [problems, setProblems] = useFieldProblems({ email, reason });
  const place = useMutation({
    mutationFn: () =>
      api.post<{ hold: LegalHold }>('/admin/compliance/holds', {
        email: email.trim(),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      setEmail('');
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMPLIANCE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
      ]);
    },
    onError: (cause) => {
      const found = apiErrorProblems(cause, 'The hold could not be placed.', {
        email: 'Email address',
        reason: 'Reason',
      });
      setProblems(
        cause instanceof ApiError && cause.status === 404
          ? found.map((problem) => ({ ...problem, fields: ['email'] }))
          : found,
      );
    },
  });
  const other = problemsElsewhere(problems, ['email', 'reason']);

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setProblems([]);
        if (email.trim() && reason.trim()) place.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Person’s email address"
          htmlFor="hold-email"
          error={problemsAt(problems, 'email')}
        >
          <Input
            id="hold-email"
            {...invalidFieldProps('hold-email', problemsAt(problems, 'email'))}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label="Reason"
          htmlFor="hold-reason"
          hint="A matter or case reference. Recorded in the audit log."
          error={problemsAt(problems, 'reason')}
        >
          <Input
            id="hold-reason"
            {...invalidFieldProps('hold-reason', problemsAt(problems, 'reason'))}
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={place.isPending || !email.trim() || !reason.trim()}>
          {place.isPending ? <Spinner /> : <FileLock />}
          Place hold
        </Button>
      </div>
      {other && (
        <p role="alert" className="whitespace-pre-line text-[var(--danger)] text-sm">
          {other}
        </p>
      )}
    </form>
  );
}

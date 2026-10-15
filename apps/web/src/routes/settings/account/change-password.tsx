import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { useCurrentUser } from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import { translate, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';
import {
  type AuthResult,
  authErrorMessage,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSIONS_KEY,
} from './account-helpers';

/** The field a refusal from the sign-in service is about, by its code. */
const REFUSAL_FIELDS: Record<string, string> = {
  INVALID_PASSWORD: 'current',
  PASSWORD_TOO_SHORT: 'next',
  PASSWORD_TOO_LONG: 'next',
};

/** Every problem with what was typed, each with its field (#320's sweep). */
export function passwordProblems(current: string, next: string, confirm: string): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (!current)
    problems.push({ fields: ['current'], text: translate('settings.account.enterCurrent') });
  if (next.length < PASSWORD_MIN) {
    problems.push({
      fields: ['next'],
      text: translate('settings.account.passwordTooShort', { count: PASSWORD_MIN }),
    });
  } else if (next.length > PASSWORD_MAX) {
    problems.push({
      fields: ['next'],
      text: translate('settings.account.passwordTooLong', { count: PASSWORD_MAX }),
    });
  } else if (current && next === current) {
    problems.push({
      fields: ['next'],
      text: translate('settings.account.passwordSame'),
    });
  }
  if (next !== confirm) {
    problems.push({ fields: ['confirm'], text: translate('settings.account.passwordMismatch') });
  }
  return problems;
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  // A password change is refused while read-only: off with the reason, so nobody
  // types a password to be told no (#353).
  const lock = useReadOnlyLock();
  const formId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  // Every problem at once, each under its field and kept until that field is
  // edited, rather than one at a time at the foot. A read-only refusal goes
  // once changes are accepted again (#308).
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems({ current, next, confirm }, form);
  const at = (field: string) => problemsAt(problems, field);
  const error = problemsElsewhere(problems, ['current', 'next', 'confirm']);
  const [done, setDone] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: async () => {
      const result = (await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      })) as AuthResult;
      const message = authErrorMessage(result, translate('settings.account.passwordChangeFailed'));
      if (message) throw Object.assign(new Error(message), { code: result.error?.code });
    },
    onSuccess: () => {
      setDone(
        translate(
          revokeOthers
            ? 'settings.account.passwordChangedSignedOut'
            : 'settings.account.passwordChanged',
        ),
      );
      setCurrent('');
      setNext('');
      setConfirm('');
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (failure: Error & { code?: string }) => {
      const field = REFUSAL_FIELDS[failure.code ?? ''];
      setProblems([{ fields: field ? [field] : [], text: failure.message }]);
    },
  });

  function reset(nextOpen: boolean) {
    if (!nextOpen) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setRevokeOthers(true);
      setProblems([]);
      setDone(null);
      change.reset();
    }
    onOpenChange(nextOpen);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    const found = passwordProblems(current, next, confirm);
    setProblems(found);
    if (found.length === 0) change.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent
        aria-describedby={`${formId}-description`}
        // Escape or a click outside asks before throwing typed passwords away (#314).
        confirmDiscard={!done && Boolean(current || next || confirm)}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.account.changePassword')}</DialogTitle>
          <DialogDescription id={`${formId}-description`}>
            {t('settings.account.changePasswordDescription', { count: PASSWORD_MIN })}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <p role="status" className="text-sm text-[var(--success)]">
              {done}
            </p>
            <DialogFooter>
              <Button variant="accent" onClick={() => reset(false)}>
                {t('settings.account.done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form ref={form} onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field
              label={t('settings.account.currentPassword')}
              htmlFor={`${formId}-current`}
              error={at('current')}
            >
              <Input
                id={`${formId}-current`}
                {...invalidFieldProps(`${formId}-current`, at('current'))}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
            <Field
              label={t('settings.account.newPassword')}
              htmlFor={`${formId}-new`}
              error={at('next')}
              hint={t('settings.account.passwordRange', { min: PASSWORD_MIN, max: PASSWORD_MAX })}
            >
              <Input
                id={`${formId}-new`}
                {...invalidFieldProps(`${formId}-new`, at('next'))}
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </Field>
            <Field
              label={t('settings.account.confirmPassword')}
              htmlFor={`${formId}-confirm`}
              error={at('confirm')}
            >
              <Input
                id={`${formId}-confirm`}
                {...invalidFieldProps(`${formId}-confirm`, at('confirm'))}
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={revokeOthers}
                onChange={(event) => setRevokeOthers(event.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              {t('settings.account.signOutOthers')}
            </label>
            {error && (
              <p role="alert" className="whitespace-pre-line text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={() => reset(false)}>
                {t('settings.account.cancel')}
              </Button>
              <Button
                type="submit"
                variant="accent"
                locked={lock.title}
                disabled={change.isPending}
              >
                {change.isPending && <Spinner />}
                {t('settings.account.changePassword')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What the Password row shows: the change button, or why there is none. */
export function PasswordControl({ onChange }: { onChange: () => void }) {
  const t = useT();
  const { data } = useCurrentUser();
  const lock = useReadOnlyLock();
  const signIn = data?.signIn;
  if (!signIn) return null;
  if (signIn.password) {
    return (
      <Button variant="secondary" size="sm" locked={lock.title} onClick={onChange}>
        {t('settings.account.changePasswordButton')}
      </Button>
    );
  }
  return (
    <p className="text-sm text-[var(--text-muted)]">
      {signIn.credential
        ? t('settings.account.localAuthDisabled')
        : t('settings.account.passwordManaged')}
    </p>
  );
}

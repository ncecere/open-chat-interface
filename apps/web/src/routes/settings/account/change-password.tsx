import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import {
  type AuthResult,
  authErrorMessage,
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSIONS_KEY,
} from './account-helpers';

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));
  const [done, setDone] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: async () => {
      const result = (await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      })) as AuthResult;
      const message = authErrorMessage(result, 'Your password could not be changed. Try again.');
      if (message) throw new Error(message);
    },
    onSuccess: () => {
      setDone(
        revokeOthers
          ? 'Your password has been changed and your other devices have been signed out.'
          : 'Your password has been changed.',
      );
      setCurrent('');
      setNext('');
      setConfirm('');
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
    onError: (failure) => setError(failure.message),
  });

  function reset(nextOpen: boolean) {
    if (!nextOpen) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setRevokeOthers(true);
      setError(null);
      setDone(null);
      change.reset();
    }
    onOpenChange(nextOpen);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    if (!current) return setError('Enter your current password.');
    if (next.length < PASSWORD_MIN)
      return setError(`Your new password must be at least ${PASSWORD_MIN} characters.`);
    if (next.length > PASSWORD_MAX)
      return setError(`Your new password must be at most ${PASSWORD_MAX} characters.`);
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('Choose a password different from your current one.');
    setError(null);
    change.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent aria-describedby={`${formId}-description`}>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription id={`${formId}-description`}>
            Use at least {PASSWORD_MIN} characters. You will stay signed in on this device.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <p role="status" className="text-sm text-[var(--success)]">
              {done}
            </p>
            <DialogFooter>
              <Button variant="accent" onClick={() => reset(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field label="Current password" htmlFor={`${formId}-current`}>
              <Input
                id={`${formId}-current`}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
            <Field
              label="New password"
              htmlFor={`${formId}-new`}
              hint={`${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`}
            >
              <Input
                id={`${formId}-new`}
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </Field>
            <Field label="Confirm new password" htmlFor={`${formId}-confirm`}>
              <Input
                id={`${formId}-confirm`}
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
              Sign out of all other devices
            </label>
            {error && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={() => reset(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="accent" disabled={change.isPending}>
                {change.isPending && <Spinner />}
                Change password
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
  const { data } = useCurrentUser();
  const signIn = data?.signIn;
  if (!signIn) return null;
  if (signIn.password) {
    return (
      <Button variant="secondary" size="sm" onClick={onChange}>
        Change Password
      </Button>
    );
  }
  return (
    <p className="text-sm text-[var(--text-muted)]">
      {signIn.credential
        ? 'Email and password sign-in is turned off on this instance.'
        : "Your password is managed by your organisation's sign-in."}
    </p>
  );
}

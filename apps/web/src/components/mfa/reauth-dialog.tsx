import type { RecoveryCodesResponse } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { RecoveryCodes } from '~/components/mfa/recovery-codes';
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
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api } from '~/lib/api-client';
import { currentCode, MFA_STATUS_KEY, mfaProblems } from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';

export type ReauthKind = 'regenerate' | 'disable';

const COPY = {
  regenerate: {
    title: 'Get new recovery codes',
    description:
      'The codes you have now will stop working. Enter your password and a current code to continue.',
    confirm: 'Get new codes',
    path: '/me/mfa/recovery-codes',
    failed: 'New recovery codes could not be made. Try again.',
  },
  disable: {
    title: 'Turn off the authenticator app?',
    description:
      'You will no longer be asked for a code when you sign in. Enter your password and a current code to confirm.',
    confirm: 'Turn off authenticator',
    path: '/me/mfa/totp/disable',
    failed: 'The authenticator app could not be turned off. Try again.',
  },
} as const;

/**
 * The two actions that need the password and a current code, so a stolen
 * session is not enough (#399): new recovery codes, and turning the
 * authenticator off. Wrong ones are said under their field; the server counts
 * them toward the lockout, so a locked second step is said here too.
 *
 * New codes are shown in this dialog once. The old ones stopped working when
 * the request was answered, so the dialog cannot be dismissed until the person
 * has said they saved the new ones.
 */
export function ReauthDialog({
  kind,
  open,
  onOpenChange,
  onDone,
}: {
  kind: ReauthKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After turning it off, or after the new codes were saved. */
  onDone: (message: string) => void;
}) {
  const copy = COPY[kind];
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // Held in state only, as at enrolment.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [problems, setProblems] = useFieldProblems({ password, code }, form);
  const passwordId = `${id}-password`;
  const codeId = `${id}-code`;

  function reset() {
    setPassword('');
    setCode('');
    setProblems([]);
    setRecoveryCodes(null);
    setSaved(false);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const missing: { fields: string[]; text: string }[] = [];
    if (!password) missing.push({ fields: ['password'], text: 'Enter your password.' });
    if (!code.trim())
      missing.push({
        fields: ['code'],
        text: 'Enter a code from your authenticator app, or a recovery code.',
      });
    if (missing.length > 0) {
      setProblems(missing);
      return;
    }
    setBusy(true);
    try {
      const answer = await api.post<RecoveryCodesResponse | { ok: true }>(copy.path, {
        password,
        code: currentCode(code),
      });
      // Both swap or change what the account has: look at it again.
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
      void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
      if (kind === 'regenerate' && 'recoveryCodes' in answer) {
        setPassword('');
        setCode('');
        setProblems([]);
        setRecoveryCodes(answer.recoveryCodes);
      } else {
        reset();
        onOpenChange(false);
        onDone('The authenticator app is turned off.');
      }
    } catch (error) {
      setProblems(mfaProblems(error, copy.failed));
    } finally {
      setBusy(false);
    }
  }

  const showingCodes = recoveryCodes !== null;
  const elsewhere = problemsElsewhere(problems, ['password', 'code']);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        // Closing with the new codes unsaved would lose them for good.
        closeButton={!showingCodes}
        onEscapeKeyDown={(event) => showingCodes && !saved && event.preventDefault()}
        onPointerDownOutside={(event) => showingCodes && !saved && event.preventDefault()}
        confirmDiscard={!showingCodes && Boolean(password || code)}
      >
        <DialogHeader>
          <DialogTitle>{showingCodes ? 'Your new recovery codes' : copy.title}</DialogTitle>
          <DialogDescription>
            {showingCodes ? 'The old codes no longer work.' : copy.description}
          </DialogDescription>
        </DialogHeader>

        {showingCodes ? (
          <RecoveryCodes
            heading="Save your new recovery codes"
            codes={recoveryCodes}
            onSavedChange={setSaved}
            onDone={() => {
              reset();
              onOpenChange(false);
              onDone('New recovery codes are ready. The old ones no longer work.');
            }}
          />
        ) : (
          <form ref={form} onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field
              label="Current password"
              htmlFor={passwordId}
              error={problemsAt(problems, 'password')}
            >
              <Input
                id={passwordId}
                {...invalidFieldProps(passwordId, problemsAt(problems, 'password'))}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field
              label="Authentication or recovery code"
              htmlFor={codeId}
              error={problemsAt(problems, 'code')}
              hint="The 6-digit code from your authenticator app, or one of your recovery codes. You can paste it."
            >
              <Input
                id={codeId}
                {...invalidFieldProps(codeId, problemsAt(problems, 'code'))}
                type="text"
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            {elsewhere && (
              <p role="alert" className="whitespace-pre-line text-sm text-[var(--danger)]">
                {elsewhere}
              </p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={kind === 'disable' ? 'danger' : 'accent'}
                locked={lock.title}
                disabled={busy}
              >
                {busy && <Spinner />}
                {copy.confirm}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

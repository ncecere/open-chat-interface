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
import { type Translate, useT } from '~/lib/i18n';
import { currentCode, MFA_STATUS_KEY, mfaProblems } from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';

export type ReauthKind = 'regenerate' | 'disable';

/** What each action says, in the language showing now. */
function copyFor(kind: ReauthKind, t: Translate) {
  return kind === 'regenerate'
    ? {
        title: t('auth.reauth.regenerateTitle'),
        description: t('auth.reauth.regenerateDescription'),
        confirm: t('auth.reauth.regenerateConfirm'),
        path: '/me/mfa/recovery-codes',
        failed: t('auth.reauth.regenerateFailed'),
      }
    : {
        title: t('auth.reauth.disableTitle'),
        description: t('auth.reauth.disableDescription'),
        confirm: t('auth.reauth.disableConfirm'),
        path: '/me/mfa/totp/disable',
        failed: t('auth.reauth.disableFailed'),
      };
}

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
  const t = useT();
  const copy = copyFor(kind, t);
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
    if (!password) missing.push({ fields: ['password'], text: t('auth.form.passwordRequired') });
    if (!code.trim())
      missing.push({
        fields: ['code'],
        text: t('auth.reauth.codeRequired'),
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
        onDone(t('auth.reauth.disableDone'));
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
          <DialogTitle>{showingCodes ? t('auth.reauth.newCodesTitle') : copy.title}</DialogTitle>
          <DialogDescription>
            {showingCodes ? t('auth.reauth.oldStopped') : copy.description}
          </DialogDescription>
        </DialogHeader>

        {showingCodes ? (
          <RecoveryCodes
            heading={t('auth.reauth.newCodesHeading')}
            codes={recoveryCodes}
            onSavedChange={setSaved}
            onDone={() => {
              reset();
              onOpenChange(false);
              onDone(t('auth.reauth.newCodesDone'));
            }}
          />
        ) : (
          <form ref={form} onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field
              label={t('auth.common.currentPassword')}
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
              label={t('auth.reauth.codeLabel')}
              htmlFor={codeId}
              error={problemsAt(problems, 'code')}
              hint={t('auth.reauth.codeHint')}
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
                {t('auth.common.cancel')}
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

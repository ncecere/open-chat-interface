import type { MfaStatus, PasskeySummary } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Pencil, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { bdiMessage } from '~/components/auth/bdi-message';
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
import { authClient } from '~/lib/auth-client';
import { answered } from '~/lib/auth-unavailable';
import { useT } from '~/lib/i18n';
import {
  MFA_STATUS_KEY,
  type PasskeyProblem,
  passkeyManageProblem,
  webAuthnSupported,
} from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';
import { failureOf, retryAfterCapture } from '~/lib/second-step';

type Dialogs =
  | { kind: 'add' }
  | { kind: 'rename'; passkey: PasskeySummary }
  | { kind: 'remove'; passkey: PasskeySummary }
  | null;

/** A refusal or a cancel inside a dialog: an error is announced, a cancel is said calmly. */
function Problem({ problem }: { problem: PasskeyProblem | null }) {
  if (!problem) return null;
  return problem.kind === 'error' ? (
    <p role="alert" className="text-sm text-[var(--danger)]">
      {problem.text}
    </p>
  ) : (
    <p role="status" className="text-sm text-[var(--text-muted)]">
      {problem.text}
    </p>
  );
}

/**
 * The person's passkeys (#399): the list is OCI's (`GET /api/me/mfa`, never the
 * public key or the counter), add, rename and remove go through the passkey
 * client. Adding needs a recent sign-in and a browser with WebAuthn; both are
 * said in words.
 */
export function PasskeySection({
  passkeys,
  onNotice,
}: {
  passkeys: MfaStatus['passkeys'];
  onNotice: (message: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const supported = webAuthnSupported();

  function changed(message: string) {
    setDialog(null);
    onNotice(message);
    void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        {t('auth.passkeys.title')}
      </h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{t('auth.passkeys.intro')}</p>

      {passkeys.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('auth.passkeys.none')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              data-testid="passkey"
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-sm font-medium text-[var(--text-primary)]">
                  {passkey.name || t('auth.passkeys.defaultName')}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {[
                    passkey.createdAt
                      ? t('auth.passkeys.added', { date: passkey.createdAt })
                      : null,
                    passkey.deviceType === 'multiDevice' || passkey.backedUp
                      ? t('auth.passkeys.synced')
                      : t('auth.passkeys.deviceOnly'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('auth.passkeys.renameAria', {
                    name: passkey.name || t('auth.passkeys.defaultNameLower'),
                  })}
                  locked={lock.title}
                  onClick={() => setDialog({ kind: 'rename', passkey })}
                >
                  <Pencil />
                  {t('auth.passkeys.rename')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('auth.passkeys.removeAria', {
                    name: passkey.name || t('auth.passkeys.defaultNameLower'),
                  })}
                  locked={lock.title}
                  onClick={() => setDialog({ kind: 'remove', passkey })}
                >
                  <Trash2 />
                  {t('auth.passkeys.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        {supported ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            locked={lock.title}
            onClick={() => setDialog({ kind: 'add' })}
          >
            <Fingerprint />
            {t('auth.passkeys.add')}
          </Button>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">{t('auth.passkeys.unsupported')}</p>
        )}
      </div>

      <AddPasskeyDialog
        open={dialog?.kind === 'add'}
        onOpenChange={(open) => !open && setDialog(null)}
        onAdded={() => changed(t('auth.passkeys.noticeAdded'))}
      />
      <RenamePasskeyDialog
        passkey={dialog?.kind === 'rename' ? dialog.passkey : null}
        onOpenChange={(open) => !open && setDialog(null)}
        onRenamed={() => changed(t('auth.passkeys.noticeRenamed'))}
      />
      <RemovePasskeyDialog
        passkey={dialog?.kind === 'remove' ? dialog.passkey : null}
        onOpenChange={(open) => !open && setDialog(null)}
        onRemoved={() => changed(t('auth.passkeys.noticeRemoved'))}
      />
    </div>
  );
}

function AddPasskeyDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PasskeyProblem | null>(null);

  async function add(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    const { captured, fetchOptions } = retryAfterCapture();
    // The browser asks for the passkey now.
    const result = await answered(
      authClient.passkey.addPasskey({ name: name.trim() || undefined, fetchOptions }),
    );
    setBusy(false);
    if (result.error) {
      setProblem(passkeyManageProblem(failureOf(result.error, captured.seconds)));
      return;
    }
    setName('');
    onAdded();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setName('');
          setProblem(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('auth.passkeys.add')}</DialogTitle>
          <DialogDescription>{t('auth.passkeys.addDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={add} noValidate className="flex flex-col gap-4">
          <Field
            label={t('auth.common.name')}
            htmlFor={`${id}-name`}
            hint={t('auth.passkeys.nameHint')}
          >
            <Input
              id={`${id}-name`}
              type="text"
              autoComplete="off"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Problem problem={problem} />
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('auth.common.cancel')}
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy && <Spinner />}
              {t('auth.passkeys.addSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenamePasskeyDialog({
  passkey,
  onOpenChange,
  onRenamed,
}: {
  passkey: PasskeySummary | null;
  onOpenChange: (open: boolean) => void;
  onRenamed: () => void;
}) {
  return (
    <Dialog open={passkey !== null} onOpenChange={onOpenChange}>
      {passkey && (
        <RenameForm
          key={passkey.id}
          passkey={passkey}
          onCancel={() => onOpenChange(false)}
          onRenamed={onRenamed}
        />
      )}
    </Dialog>
  );
}

function RenameForm({
  passkey,
  onCancel,
  onRenamed,
}: {
  passkey: PasskeySummary;
  onCancel: () => void;
  onRenamed: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(passkey.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PasskeyProblem | null>(null);
  const [empty, setEmpty] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (!name.trim()) {
      setEmpty(true);
      return;
    }
    setBusy(true);
    const result = await answered(
      authClient.passkey.updatePasskey({ id: passkey.id, name: name.trim() }),
    );
    setBusy(false);
    if (result.error) {
      setProblem(passkeyManageProblem(failureOf(result.error, null)));
      return;
    }
    onRenamed();
  }

  const error = empty ? t('auth.passkeys.nameRequired') : null;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('auth.passkeys.renameTitle')}</DialogTitle>
        <DialogDescription>{t('auth.passkeys.renameDescription')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        <Field label={t('auth.common.name')} htmlFor={`${id}-name`} error={error}>
          <Input
            id={`${id}-name`}
            {...invalidFieldProps(`${id}-name`, error)}
            type="text"
            autoComplete="off"
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setEmpty(false);
            }}
          />
        </Field>
        <Problem problem={problem} />
        <DialogFooter className="mt-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('auth.common.cancel')}
          </Button>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy && <Spinner />}
            {t('auth.passkeys.saveName')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RemovePasskeyDialog({
  passkey,
  onOpenChange,
  onRemoved,
}: {
  passkey: PasskeySummary | null;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PasskeyProblem | null>(null);

  async function remove() {
    if (!passkey) return;
    setProblem(null);
    setBusy(true);
    const result = await answered(authClient.passkey.deletePasskey({ id: passkey.id }));
    setBusy(false);
    if (result.error) {
      setProblem(passkeyManageProblem(failureOf(result.error, null)));
      return;
    }
    onRemoved();
  }

  return (
    <Dialog
      open={passkey !== null}
      onOpenChange={(next) => {
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
    >
      {passkey && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('auth.passkeys.removeTitle')}</DialogTitle>
            <DialogDescription>
              {bdiMessage(t, 'auth.passkeys.removeDescription', undefined, {
                name: passkey.name || t('auth.passkeys.defaultName'),
              })}
            </DialogDescription>
          </DialogHeader>
          <Problem problem={problem} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('auth.common.cancel')}
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={remove}>
              {busy && <Spinner />}
              {t('auth.passkeys.removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

import type { MfaStatus, PasskeySummary } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Pencil, Trash2 } from 'lucide-react';
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
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { authClient } from '~/lib/auth-client';
import { answered } from '~/lib/auth-unavailable';
import { formatDate } from '~/lib/i18n/format';
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

const addedOn = (iso: string | null) => (iso ? `Added ${formatDate(iso, 'long')}` : null);

const kindOf = (passkey: PasskeySummary) =>
  passkey.deviceType === 'multiDevice' || passkey.backedUp
    ? 'Synced across your devices'
    : 'This device only';

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
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Passkeys</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Sign in with your fingerprint, face, screen lock or a security key instead of a password and
        a code. A passkey is a second step on its own.
      </p>

      {passkeys.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-secondary)]">No passkeys yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              data-testid="passkey"
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {passkey.name || 'Passkey'}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {[addedOn(passkey.createdAt), kindOf(passkey)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename ${passkey.name || 'passkey'}`}
                  locked={lock.title}
                  onClick={() => setDialog({ kind: 'rename', passkey })}
                >
                  <Pencil />
                  Rename
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${passkey.name || 'passkey'}`}
                  locked={lock.title}
                  onClick={() => setDialog({ kind: 'remove', passkey })}
                >
                  <Trash2 />
                  Remove
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
            Add a passkey
          </Button>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">
            This browser cannot make passkeys. Use a current version of Chrome, Edge, Safari or
            Firefox on a device with a screen lock or a security key to add one.
          </p>
        )}
      </div>

      <AddPasskeyDialog
        open={dialog?.kind === 'add'}
        onOpenChange={(open) => !open && setDialog(null)}
        onAdded={() => changed('Passkey added.')}
      />
      <RenamePasskeyDialog
        passkey={dialog?.kind === 'rename' ? dialog.passkey : null}
        onOpenChange={(open) => !open && setDialog(null)}
        onRenamed={() => changed('Passkey renamed.')}
      />
      <RemovePasskeyDialog
        passkey={dialog?.kind === 'remove' ? dialog.passkey : null}
        onOpenChange={(open) => !open && setDialog(null)}
        onRemoved={() => changed('Passkey removed.')}
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
          <DialogTitle>Add a passkey</DialogTitle>
          <DialogDescription>
            Your browser will ask you to confirm with your fingerprint, face, screen lock or
            security key.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={add} noValidate className="flex flex-col gap-4">
          <Field
            label="Name"
            htmlFor={`${id}-name`}
            hint="Optional. Helps you tell your passkeys apart, such as “Work laptop”."
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
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy && <Spinner />}
              Add passkey
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

  const error = empty ? 'Enter a name.' : null;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Rename passkey</DialogTitle>
        <DialogDescription>Choose a name that helps you recognise it.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        <Field label="Name" htmlFor={`${id}-name`} error={error}>
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
            Cancel
          </Button>
          <Button type="submit" variant="accent" disabled={busy}>
            {busy && <Spinner />}
            Save name
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
            <DialogTitle>Remove this passkey?</DialogTitle>
            <DialogDescription>
              “{passkey.name || 'Passkey'}” will no longer sign you in. You can add it again later.
            </DialogDescription>
          </DialogHeader>
          <Problem problem={problem} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={remove}>
              {busy && <Spinner />}
              Remove passkey
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

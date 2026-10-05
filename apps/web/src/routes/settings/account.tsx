import { type AccountSession, PROFILE_NAME_MAX_LENGTH } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { AccountDeletionText, deletionConfirmed } from '~/components/account/account-deletion';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Badge } from '~/components/ui/badge';
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
import { api, apiErrorMessage } from '~/lib/api-client';
import { authClient } from '~/lib/auth-client';
import { describeUserAgent } from '~/lib/user-agent';
import { formatRelativeTime } from '~/lib/utils';

/** The instance's password rules (Better Auth `emailAndPassword`). */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 200;
const SESSIONS_KEY = ['me', 'sessions'] as const;

const SSO_NAME_NOTE = "From your organisation's sign-in";

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** Better Auth's client returns errors rather than throwing them. */
interface AuthResult {
  error?: { code?: string; message?: string; status?: number } | null;
}

function authErrorMessage(result: AuthResult, fallback: string): string | null {
  const error = result.error;
  if (!error) return null;
  switch (error.code) {
    case 'INVALID_PASSWORD':
      return 'Your current password is not correct.';
    case 'PASSWORD_TOO_SHORT':
      return `Your new password must be at least ${PASSWORD_MIN} characters.`;
    case 'PASSWORD_TOO_LONG':
      return `Your new password must be at most ${PASSWORD_MAX} characters.`;
    case 'LOCAL_AUTH_DISABLED':
      return 'Email and password sign-in is turned off on this instance.';
    case 'PROFILE_MANAGED_BY_SSO':
      return "Your name comes from your organisation's sign-in.";
    default:
      return error.message || fallback;
  }
}

function NameRow({ name, editable }: { name: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const trimmed = draft.trim();

  const save = useMutation({
    mutationFn: async (next: string) => {
      const result = (await authClient.updateUser({ name: next })) as AuthResult;
      const message = authErrorMessage(result, 'Your name could not be saved. Try again.');
      if (message) throw new Error(message);
    },
    onSuccess: async () => {
      setEditing(false);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (failure) => setError(failure.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length < 1 || trimmed.length > PROFILE_NAME_MAX_LENGTH) {
      setError(`Your name must be 1 to ${PROFILE_NAME_MAX_LENGTH} characters.`);
      return;
    }
    setError(null);
    save.mutate(trimmed);
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="border-b border-[var(--border-subtle)] pb-3">
        <label htmlFor={inputId} className="text-[var(--text-muted)]">
          Name
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            value={draft}
            maxLength={PROFILE_NAME_MAX_LENGTH}
            autoComplete="name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="accent" size="sm" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="mt-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
      <span className="text-[var(--text-muted)]">Name</span>
      <span className="flex min-w-0 items-center gap-2">
        {saved && (
          <span role="status" className="text-xs text-[var(--success)]">
            Saved
          </span>
        )}
        <span className="truncate text-[var(--text-primary)]">{name}</span>
        {editable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Edit name"
            onClick={() => {
              setDraft(name);
              setSaved(false);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function ChangePasswordDialog({
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

function SessionRow({
  session,
  onSignOut,
  pending,
}: {
  session: AccountSession;
  onSignOut: () => void;
  pending: boolean;
}) {
  const name = describeUserAgent(session.userAgent);
  return (
    <li
      className="flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0"
      data-testid="account-session"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-primary)]">
          {name}
          {session.current && <Badge variant="success">This device</Badge>}
          {session.impersonated && <Badge variant="warning">Administrator session</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          {session.ipAddress ? `${session.ipAddress} · ` : ''}Signed in{' '}
          {formatRelativeTime(session.createdAt)} ·{' '}
          {/* The device you are reading this on is in use now; the server
              records activity in five-minute steps (#98). */}
          {session.current
            ? 'Active now'
            : `Last active ${formatRelativeTime(session.lastActiveAt)}`}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          aria-label={`Sign out ${name}, signed in ${formatRelativeTime(session.createdAt)}`}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

function DevicesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const sessions = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api.get<{ sessions: AccountSession[] }>('/me/sessions'),
    select: (data) => data.sessions,
    enabled: open,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });

  const signOutOne = useMutation({
    mutationFn: (id: string) => api.delete(`/me/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setMessage('That device has been signed out.');
      return refresh();
    },
  });
  const signOutOthers = useMutation({
    mutationFn: () => api.post<{ revoked: number }>('/me/sessions/revoke-others'),
    onSuccess: (result) => {
      setMessage(
        result.revoked === 1
          ? '1 other device has been signed out.'
          : `${result.revoked} other devices have been signed out.`,
      );
      return refresh();
    },
  });
  const error = signOutOne.error ?? signOutOthers.error;
  const list = sessions.data ?? [];
  const others = list.filter((session) => !session.current).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setMessage('');
          signOutOne.reset();
          signOutOthers.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Devices</DialogTitle>
          <DialogDescription>
            Where your account is signed in. A device you sign out may stay signed in for up to five
            minutes.
          </DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <div className="py-8" role="status" aria-label="Loading devices">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : sessions.isError ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            Your devices could not be loaded. Try again.
          </p>
        ) : (
          <ul aria-label="Signed-in devices" className="flex max-h-[50vh] flex-col overflow-y-auto">
            {list.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                pending={signOutOne.isPending && signOutOne.variables === session.id}
                onSignOut={() => signOutOne.mutate(session.id)}
              />
            ))}
          </ul>
        )}
        <p role="status" aria-live="polite" className="mt-2 text-xs text-[var(--text-muted)]">
          {message}
        </p>
        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {apiErrorMessage(error, 'That could not be done. Try again.')}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="secondary"
            disabled={others === 0 || signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
          >
            {signOutOthers.isPending && <Spinner />}
            Sign out all other devices
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the Password row shows: the change button, or why there is none. */
function PasswordControl({ onChange }: { onChange: () => void }) {
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

/**
 * Deleting your own account (v0.10), when an administrator has allowed it for
 * your role under Roles & access. The email must be typed, and an account
 * with a password also enters it. The server refuses under legal hold and for
 * the last administrator; its message is shown in the dialog.
 */
function DeleteAccountSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  if (!data) return null;

  if (!data.features.accountDeletion) {
    return (
      <p className="mt-12 text-sm text-[var(--text-muted)]">
        To delete your account, contact your administrator.
      </p>
    );
  }

  const email = data.user.email;
  const needsPassword = Boolean(data.signIn?.credential);
  const sso = data.signIn?.sso ?? [];

  async function deleteAccount() {
    await api.post('/me/delete-account', {
      confirmEmail: typed,
      ...(needsPassword ? { password } : {}),
    });
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <>
      <section className="mt-12" aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading" className="text-xl font-bold">
          Delete account
        </h2>
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--text-muted)]">
            Permanently delete your account and everything it owns. This cannot be undone.
          </p>
          <Button
            type="button"
            size="sm"
            variant="danger"
            className="shrink-0"
            onClick={() => {
              setTyped('');
              setPassword('');
              setOpen(true);
            }}
          >
            Delete account
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description={<AccountDeletionText subject={{ kind: 'self' }} />}
        confirmLabel="Delete my account"
        pendingLabel="Deleting…"
        errorMessage="Your account could not be deleted."
        confirmDisabled={!deletionConfirmed(typed, email) || (needsPassword && !password)}
        onConfirm={deleteAccount}
      >
        <div className="flex flex-col gap-4">
          {sso.length > 0 && (
            <p
              role="note"
              className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm"
            >
              You sign in through {sso.join(', ')}. If you sign in that way again later, a new,
              empty account is created for you.
            </p>
          )}
          <Field label={`Type ${email} to confirm`} htmlFor="delete-account-confirm">
            <Input
              id="delete-account-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          {needsPassword && (
            <Field label="Your password" htmlFor="delete-account-password">
              <Input
                id="delete-account-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}

export function SettingsAccountPage() {
  const { data } = useCurrentUser();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const signIn = data?.signIn;
  const viaOrganisation = (signIn?.sso.length ?? 0) > 0;
  // A name set by an organisation's sign-in is not edited here.
  const nameEditable = Boolean(signIn?.credential) && !viaOrganisation;

  return (
    <div>
      <h1 className="text-2xl font-bold">Account</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Your identity and access on this instance.
      </p>

      <Section title="Profile" className="mt-8">
        <div className="flex flex-col gap-3 text-sm">
          {data && <NameRow name={data.user.name} editable={nameEditable} />}
          {data && !nameEditable && viaOrganisation && (
            <p className="-mt-2 text-xs text-[var(--text-muted)]">{SSO_NAME_NOTE}</p>
          )}
          <div className="flex justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">Email</span>
            <span className="min-w-0 text-right">
              <span className="block truncate text-[var(--text-primary)]">{data?.user.email}</span>
              {viaOrganisation && (
                <span className="block text-xs text-[var(--text-muted)]">
                  Managed by your organisation
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">Role</span>
            <span className="capitalize text-[var(--text-primary)]">{data?.user.role}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">Email verified</span>
            <span className="text-[var(--text-primary)]">
              {data?.user.emailVerified ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Security & Access" className="mt-12">
        <Row label="Password" description="The password you use to sign in to this account.">
          <PasswordControl onChange={() => setPasswordOpen(true)} />
        </Row>

        <Row
          label="Devices"
          description="See where you are signed in, and sign out of devices you no longer use."
        >
          <Button variant="secondary" size="sm" onClick={() => setDevicesOpen(true)}>
            View Devices
          </Button>
        </Row>
      </Section>

      <DeleteAccountSection />

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <DevicesDialog open={devicesOpen} onOpenChange={setDevicesOpen} />
    </div>
  );
}

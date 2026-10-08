import {
  type CreatedInvite,
  createInviteSchema,
  type Invite,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, MailPlus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, Row, RowList } from '~/components/admin/admin-ui';
import { useEditedSince } from '~/components/admin/unsaved-changes';
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
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { ApiError, api, apiErrorMessage, apiErrorProblems } from '~/lib/api-client';
import { formatDateTime } from '~/lib/utils';
import { validationProblems } from '~/lib/validation-issues';

interface InvitesResponse {
  invites: Array<Omit<Invite, 'token'>>;
}

/** The form's names for the fields, so each error names the one it is about (#127). */
const INVITE_LABELS = { email: 'Email', expiresInDays: 'Expires in days' };

type ListedInvite = InvitesResponse['invites'][number];
type InviteStatus = 'active' | 'redeemed' | 'expired';

const STATUS_VARIANT = {
  active: 'success',
  redeemed: 'neutral',
  expired: 'warning',
} as const;

function inviteStatus(invite: ListedInvite): InviteStatus {
  if (invite.redeemedAt) return 'redeemed';
  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

function CreateInviteDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  // Links expire unless the admin chooses otherwise (docs/admin/people.md).
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [copyFeedback, setCopyFeedback] = useState<'copied' | 'failed' | null>(null);
  // Escape or a click outside asks before throwing edits away (#45, #300).
  const changed = useEditedSince({ email, role, expiresInDays });

  // Each problem is shown under its field, which is marked invalid and
  // described by it, and goes when that field is edited (#178, #302): an
  // address that already has an account is about the Email field.
  const [problems, setProblems] = useFieldProblems({ email, role, expiresInDays });
  const at = (field: string) => problemsAt(problems, field);
  const formError = problemsElsewhere(problems, ['email', 'expiresInDays']);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<CreatedInvite>('/admin/invites', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] }),
    onError: (error, body) => {
      // A form the page already found wrong was sent only to hear the server's
      // check of the address too (#346): if the server could not answer that
      // (the connection dropped), the problems already shown stay.
      const refusedHere = !createInviteSchema.safeParse(body).success;
      if (refusedHere && !(error instanceof ApiError && error.details)) return;
      setProblems(apiErrorProblems(error, 'Failed to create invitation.', INVITE_LABELS));
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblems([]);
    create.reset();

    const body = {
      email: email.trim() || null,
      role,
      expiresInDays: expiresInDays === '' ? null : Number(expiresInDays),
    };
    const result = createInviteSchema.safeParse(body);

    if (!result.success) {
      setProblems(
        validationProblems(result.error.issues, INVITE_LABELS).map(({ field, text }) => ({
          fields: field ? [field] : [],
          text,
        })),
      );
      // Whether the address already has an account or a pending invitation is
      // known only to the server, which checks it along with the rest. With a
      // well-formed address, the refused form is sent anyway: the server
      // refuses it for the same problems and adds the address's, so one save
      // shows both rather than the second only after the first is fixed
      // (#346). Nothing is created by a refusal.
      if (body.email && !result.error.issues.some((issue) => issue.path[0] === 'email'))
        create.mutate(body);
      return;
    }

    create.mutate(result.data);
  }

  async function copyUrl() {
    // An emailed invitation has no link to copy (#214).
    if (!create.data || create.data.emailDelivered) return;

    try {
      await navigator.clipboard.writeText(create.data.url);
      setCopyFeedback('copied');
    } catch {
      setCopyFeedback('failed');
    }
  }

  if (create.data?.emailDelivered) {
    // The link went only to the address: if it were shown here too, whoever
    // created the invitation could accept it for someone else's address, and
    // accepting it verifies that address (#214).
    const recipient = email.trim();

    return (
      <DialogContent className="w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>Invitation emailed</DialogTitle>
          <DialogDescription>
            Invitation emailed to {recipient}. The link was sent only to that address, so it is not
            shown here.
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-[var(--text-muted)]">
          When they accept it with that address, their email is already verified. If it does not
          arrive, revoke the invitation and create a new one.
        </p>

        <DialogFooter>
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  if (create.data) {
    const recipient = email.trim();

    return (
      <DialogContent className="w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>Invitation created</DialogTitle>
          <DialogDescription>
            This link is shown only once. Copy it before closing this window.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--accent-soft)] p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            One-time invite link
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              value={create.data.url}
              readOnly
              aria-label="One-time invite URL"
              onFocus={(event) => event.currentTarget.select()}
              className="bg-[var(--bg-elevated)] font-mono text-xs"
            />
            <Button type="button" variant="primary" onClick={() => void copyUrl()}>
              {copyFeedback === 'copied' ? <Check /> : <Copy />}
              {copyFeedback === 'copied' ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-[var(--text-muted)]" aria-live="polite">
            {copyFeedback === 'copied' && 'Invite link copied to your clipboard.'}
            {copyFeedback === 'failed' &&
              'Could not access the clipboard. Select and copy the link manually.'}
          </p>
        </div>

        {recipient ? (
          <div
            className="mt-4 rounded-lg bg-[var(--warning)]/15 px-3 py-2 text-sm text-[var(--warning)]"
            role="status"
          >
            The email could not be delivered to {recipient}. Share the link manually.
          </div>
        ) : (
          <p className="mt-4 text-sm text-[var(--text-muted)]">
            No email was requested. Share the invite link directly with the recipient.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent className="w-[calc(100%-2rem)]" confirmDiscard={changed}>
      <DialogHeader>
        <DialogTitle>Create invitation</DialogTitle>
        <DialogDescription>
          Generate a one-time link. Adding an email also attempts to send it automatically.
        </DialogDescription>
      </DialogHeader>

      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          label="Email (optional)"
          htmlFor="invite-email"
          hint="Leave blank for a shareable link."
          error={at('email')}
        >
          <Input
            id="invite-email"
            {...invalidFieldProps('invite-email', at('email'))}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            autoComplete="email"
            maxLength={320}
          />
        </Field>

        <Field label="Role" htmlFor="invite-role">
          <Select
            id="invite-role"
            value={role}
            onChange={(next) => setRole(next as UserRole)}
            options={USER_ROLES.map((option) => ({
              value: option,
              label: option.charAt(0).toUpperCase() + option.slice(1),
            }))}
          />
        </Field>

        <Field
          label="Expires in days"
          htmlFor="invite-expiry"
          hint="Between 1 and 365 days. Clear it for a link that never expires."
          error={at('expiresInDays')}
        >
          <Input
            id="invite-expiry"
            {...invalidFieldProps('invite-expiry', at('expiresInDays'))}
            type="number"
            min={1}
            max={365}
            step={1}
            inputMode="numeric"
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
            placeholder="No expiration"
          />
        </Field>

        {formError && (
          <p
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
            role="alert"
          >
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            Create invitation
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function RevokeInviteDialog({
  invite,
  onClose,
  onRevoked,
}: {
  invite: ListedInvite;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const revoke = useMutation({
    mutationFn: () => api.delete(`/admin/invites/${invite.id}`),
    onSuccess: onRevoked,
  });

  return (
    <DialogContent className="w-[calc(100%-2rem)] max-w-md">
      <DialogHeader>
        <DialogTitle>Revoke invitation?</DialogTitle>
        <DialogDescription>
          {invite.email
            ? `The invitation for ${invite.email} will stop working immediately.`
            : 'This invite link will stop working immediately.'}{' '}
          This action cannot be undone.
        </DialogDescription>
      </DialogHeader>

      {revoke.error && (
        <p
          className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
          role="alert"
        >
          {apiErrorMessage(revoke.error, 'Failed to revoke invitation.')}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          {revoke.isPending && <Spinner />}
          Revoke invitation
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function InviteRow({ invite, onRevoke }: { invite: ListedInvite; onRevoke: () => void }) {
  const status = inviteStatus(invite);

  return (
    <Row className="items-start gap-3 p-4 sm:px-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
        <Link2 className="size-4 text-[var(--text-secondary)]" aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 truncate font-medium text-[var(--text-primary)]">
            {invite.email ?? 'Shareable invitation'}
          </p>
          <Badge variant={STATUS_VARIANT[status]} className="capitalize">
            {status}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {invite.role}
          </Badge>
        </div>

        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-[var(--text-muted)]">Expires</dt>
            <dd
              className="mt-0.5 text-[var(--text-secondary)]"
              title={invite.expiresAt ? formatDateTime(invite.expiresAt) : undefined}
            >
              {invite.expiresAt ? formatDateTime(invite.expiresAt) : 'Never'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--text-muted)]">Created</dt>
            <dd
              className="mt-0.5 text-[var(--text-secondary)]"
              title={formatDateTime(invite.createdAt)}
            >
              {formatDateTime(invite.createdAt)}
            </dd>
          </div>
          {invite.emailedAt && (
            <div>
              <dt className="text-[var(--text-muted)]">Emailed</dt>
              <dd
                className="mt-0.5 text-[var(--text-secondary)]"
                title={formatDateTime(invite.emailedAt)}
              >
                {formatDateTime(invite.emailedAt)}
              </dd>
            </div>
          )}
          {invite.redeemedAt && (
            <div>
              <dt className="text-[var(--text-muted)]">Redeemed</dt>
              <dd
                className="mt-0.5 text-[var(--text-secondary)]"
                title={formatDateTime(invite.redeemedAt)}
              >
                {formatDateTime(invite.redeemedAt)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {status === 'active' && (
        <EditOnly>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // A shareable invitation has no address; its role and creation
            // time tell it apart from the others (#220).
            aria-label={
              invite.email
                ? `Revoke invitation for ${invite.email}`
                : `Revoke shareable ${invite.role} invitation created ${formatDateTime(invite.createdAt)}`
            }
            onClick={onRevoke}
          >
            <Trash2 />
          </Button>
        </EditOnly>
      )}
    </Row>
  );
}

export function AdminInvitesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeInvite, setRevokeInvite] = useState<ListedInvite | null>(null);

  const invites = useQuery({
    queryKey: ['admin', 'invites'],
    queryFn: () => api.get<InvitesResponse>('/admin/invites'),
  });
  const inviteList = invites.data?.invites;

  async function handleRevoked() {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'invites'] });
    setRevokeInvite(null);
  }

  return (
    <div>
      <AdminPageHeader
        title="Invitations"
        description="Create and manage invitation links for your organization."
        actions={
          <EditOnly>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <MailPlus />
              Create invitation
            </Button>
          </EditOnly>
        }
      />

      {invites.isLoading ? (
        <div
          className="flex min-h-56 items-center justify-center"
          role="status"
          aria-label="Loading invitations"
        >
          <Spinner className="size-6" />
        </div>
      ) : invites.isError || !inviteList ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Invitations could not be loaded.
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {apiErrorMessage(invites.error, 'Please try again.')}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void invites.refetch()}>
            Try again
          </Button>
        </div>
      ) : inviteList.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-[var(--text-muted)]">
            {inviteList.length} invitation
            {inviteList.length === 1 ? '' : 's'}
          </p>
          <RowList>
            {inviteList.map((invite) => (
              <InviteRow key={invite.id} invite={invite} onRevoke={() => setRevokeInvite(invite)} />
            ))}
          </RowList>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
          <MailPlus className="size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm font-medium text-[var(--text-primary)]">No invitations yet.</p>
          <p className="max-w-md text-xs text-[var(--text-muted)]">
            Create an invitation to email a recipient or generate a link you can share directly.
          </p>
          <EditOnly>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
              Create invitation
            </Button>
          </EditOnly>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {createOpen && <CreateInviteDialog onClose={() => setCreateOpen(false)} />}
      </Dialog>

      <Dialog open={Boolean(revokeInvite)} onOpenChange={(open) => !open && setRevokeInvite(null)}>
        {revokeInvite && (
          <RevokeInviteDialog
            invite={revokeInvite}
            onClose={() => setRevokeInvite(null)}
            onRevoked={() => void handleRevoked()}
          />
        )}
      </Dialog>
    </div>
  );
}

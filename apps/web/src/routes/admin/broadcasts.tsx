import {
  BROADCAST_LEVELS,
  type Broadcast,
  type BroadcastLevel,
  USER_ROLES,
  type UserRole,
  upsertBroadcastSchema,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Row,
  RowList,
} from '~/components/admin/admin-ui';
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
import { InlineMarkdown } from '~/components/ui/inline-markdown';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

const LEVEL_LABELS: Record<BroadcastLevel, string> = {
  info: 'Information',
  warning: 'Warning',
  critical: 'Critical',
};

const LEVEL_VARIANTS: Record<BroadcastLevel, 'neutral' | 'warning' | 'danger'> = {
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

interface Draft {
  title: string;
  body: string;
  level: BroadcastLevel;
  audienceRoles: UserRole[];
  dismissable: boolean;
  published: boolean;
  startsAt: string;
  endsAt: string;
}

/** Datetime-local values are local wall time; the API stores instants. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function initialDraft(broadcast: Broadcast | null): Draft {
  return {
    title: broadcast?.title ?? '',
    body: broadcast?.body ?? '',
    level: broadcast?.level ?? 'info',
    audienceRoles: broadcast?.audienceRoles ?? [],
    dismissable: broadcast?.dismissable ?? true,
    published: broadcast?.published ?? false,
    startsAt: toLocalInput(broadcast?.startsAt ?? null),
    endsAt: toLocalInput(broadcast?.endsAt ?? null),
  };
}

function BroadcastDialog({
  broadcast,
  onClose,
}: {
  broadcast: Broadcast | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => initialDraft(broadcast));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      broadcast
        ? api.put(`/admin/broadcasts/${broadcast.id}`, body)
        : api.post('/admin/broadcasts', body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'broadcasts'] }),
        queryClient.invalidateQueries({ queryKey: ['me', 'broadcasts'] }),
      ]);
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'The announcement could not be saved.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = upsertBroadcastSchema.safeParse({
      title: draft.title,
      body: draft.body,
      level: draft.level,
      audienceRoles: draft.audienceRoles,
      dismissable: draft.dismissable,
      published: draft.published,
      startsAt: fromLocalInput(draft.startsAt),
      endsAt: fromLocalInput(draft.endsAt),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the announcement fields.');
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{broadcast ? 'Edit announcement' : 'New announcement'}</DialogTitle>
        <DialogDescription>
          Shown in the application to everyone it applies to, until they dismiss it.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Title" htmlFor="broadcast-title">
          <Input
            id="broadcast-title"
            value={draft.title}
            maxLength={120}
            required
            placeholder="Planned maintenance on Saturday"
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </Field>

        <Field
          label="Message"
          htmlFor="broadcast-body"
          hint="**Bold** and [links](https://example.edu) are formatted; other Markdown is shown as typed."
        >
          <Textarea
            id="broadcast-body"
            rows={4}
            value={draft.body}
            maxLength={2_000}
            required
            onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Importance"
            htmlFor="broadcast-level"
            hint="Critical is styled to stand out; use it sparingly."
          >
            <Select
              id="broadcast-level"
              value={draft.level}
              onChange={(level) =>
                setDraft((current) => ({ ...current, level: level as BroadcastLevel }))
              }
              options={BROADCAST_LEVELS.map((level) => ({
                value: level,
                label: LEVEL_LABELS[level],
              }))}
            />
          </Field>

          <Field label="Audience" htmlFor="broadcast-roles" hint="Leave empty for everyone.">
            <div id="broadcast-roles" className="flex flex-wrap gap-1.5">
              {USER_ROLES.map((role) => {
                const selected = draft.audienceRoles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        audienceRoles: selected
                          ? current.audienceRoles.filter((entry) => entry !== role)
                          : [...current.audienceRoles, role],
                      }))
                    }
                    className={cn(
                      'rounded-full px-3 py-1 font-medium text-xs capitalize transition-colors',
                      selected
                        ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                        : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" htmlFor="broadcast-starts" hint="Blank starts immediately.">
            <Input
              id="broadcast-starts"
              type="datetime-local"
              value={draft.startsAt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, startsAt: event.target.value }))
              }
            />
          </Field>
          <Field label="Ends" htmlFor="broadcast-ends" hint="Blank never expires.">
            <Input
              id="broadcast-ends"
              type="datetime-local"
              value={draft.endsAt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, endsAt: event.target.value }))
              }
            />
          </Field>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <label
            htmlFor="broadcast-dismissable"
            className="flex items-center justify-between gap-6"
          >
            <span>
              <span className="font-medium text-sm">Can be dismissed</span>
              <span className="mt-0.5 block text-[var(--text-muted)] text-xs">
                An announcement nobody can dismiss stays on screen for as long as it is live.
              </span>
            </span>
            <Switch
              id="broadcast-dismissable"
              checked={draft.dismissable}
              onCheckedChange={(dismissable) =>
                setDraft((current) => ({ ...current, dismissable }))
              }
            />
          </label>

          <label htmlFor="broadcast-published" className="flex items-center justify-between gap-6">
            <span>
              <span className="font-medium text-sm">Published</span>
              <span className="mt-0.5 block text-[var(--text-muted)] text-xs">
                Turn off to keep a draft that nobody sees.
              </span>
            </span>
            <Switch
              id="broadcast-published"
              checked={draft.published}
              onCheckedChange={(published) => setDraft((current) => ({ ...current, published }))}
            />
          </label>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-[var(--danger-on-tint)] text-xs"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {broadcast ? 'Save changes' : 'Create announcement'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function AdminBroadcastsPage() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ broadcast: Broadcast | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<Broadcast | null>(null);

  const broadcastsQuery = useQuery({
    queryKey: ['admin', 'broadcasts'],
    queryFn: () => api.get<{ broadcasts: Broadcast[] }>('/admin/broadcasts'),
  });
  const { data, isLoading } = broadcastsQuery;

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'broadcasts'] }),
      queryClient.invalidateQueries({ queryKey: ['me', 'broadcasts'] }),
    ]);

  const reshow = useMutation({
    mutationFn: (id: string) => api.post(`/admin/broadcasts/${id}/reshow`),
    onSuccess: invalidate,
  });

  async function deleteBroadcast(broadcast: Broadcast) {
    await api.delete(`/admin/broadcasts/${broadcast.id}`);
    await invalidate();
  }

  const broadcasts = data?.broadcasts ?? [];

  return (
    <div>
      <AdminPageHeader
        title="Announcements"
        description="Tell people about planned maintenance, upcoming changes, or anything else they should see while using the instance."
        actions={
          <EditOnly>
            <Button variant="primary" onClick={() => setFormFor({ broadcast: null })}>
              <Megaphone />
              New announcement
            </Button>
          </EditOnly>
        }
      />

      <MutationError
        error={reshow.error}
        message="The announcement could not be shown again."
        className="mb-4"
      />

      {isLoading ? (
        <Spinner className="mx-auto size-6" />
      ) : broadcastsQuery.isError || !data ? (
        <LoadError title="Announcements could not be loaded." query={broadcastsQuery} />
      ) : broadcasts.length > 0 ? (
        <RowList>
          {broadcasts.map((broadcast) => (
            <Row key={broadcast.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium">{broadcast.title}</p>
                  <Badge variant={LEVEL_VARIANTS[broadcast.level]}>
                    {LEVEL_LABELS[broadcast.level]}
                  </Badge>
                  {broadcast.active ? (
                    <Badge variant="accent">showing</Badge>
                  ) : (
                    <Badge variant="outline">{broadcast.published ? 'scheduled' : 'draft'}</Badge>
                  )}
                </div>
                <p className="truncate text-[var(--text-muted)] text-xs">
                  {broadcast.audienceRoles.length === 0
                    ? 'Everyone'
                    : broadcast.audienceRoles.join(', ')}
                  {broadcast.dismissalCount > 0
                    ? ` · dismissed by ${broadcast.dismissalCount}`
                    : ''}
                  {broadcast.dismissable ? '' : ' · cannot be dismissed'}
                </p>
                {/* The message itself, for everyone who can open this page:
                    auditors have no edit dialog to read it in (#87). */}
                <p className="mt-1 break-words text-[var(--text-secondary)] text-sm">
                  <InlineMarkdown text={broadcast.body} />
                </p>
              </div>

              <EditOnly>
                {broadcast.dismissalCount > 0 && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Show ${broadcast.title} again to everyone`}
                    title="Show again to everyone who dismissed it"
                    disabled={reshow.isPending}
                    onClick={() => reshow.mutate(broadcast.id)}
                  >
                    <RotateCcw />
                  </Button>
                )}

                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${broadcast.title}`}
                  onClick={() => setFormFor({ broadcast })}
                >
                  <Pencil />
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${broadcast.title}`}
                  onClick={() => setDeleteFor(broadcast)}
                >
                  <Trash2 />
                </Button>
              </EditOnly>
            </Row>
          ))}
        </RowList>
      ) : (
        <EmptyState icon={Megaphone} title="No announcements yet.">
          An announcement appears above the conversation for everyone it applies to, and stays until
          they dismiss it.
        </EmptyState>
      )}

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title={`Delete ${deleteFor?.title ?? 'announcement'}?`}
        description={
          deleteFor?.active
            ? 'It is showing now and will disappear for everyone immediately. This action cannot be undone.'
            : 'It will not be shown to anyone. This action cannot be undone.'
        }
        confirmLabel="Delete announcement"
        pendingLabel="Deleting…"
        errorMessage="The announcement could not be deleted."
        onConfirm={() => (deleteFor ? deleteBroadcast(deleteFor) : Promise.resolve())}
      />

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <BroadcastDialog broadcast={formFor.broadcast} onClose={() => setFormFor(null)} />
        )}
      </Dialog>
    </div>
  );
}

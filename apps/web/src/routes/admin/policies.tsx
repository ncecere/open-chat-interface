import { type UsagePolicy, updatePolicyDraftSchema, upsertUsagePolicySchema } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Pencil, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  Notice,
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
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { useClearOnEdit } from '~/hooks/use-clear-on-edit';
import { api, apiErrorMessage } from '~/lib/api-client';
import { formatDate } from '~/lib/utils';
import { validationText } from '~/lib/validation-issues';

/** The form's names for the fields, as errors should use them (#228). */
const POLICY_LABELS = { title: 'Title', body: 'Policy text' };

/**
 * Writes a new version, or rewords a draft (`draft`). A published version is
 * never edited: people may have accepted its wording.
 */
function PolicyDialog({
  latest,
  draft,
  onClose,
}: {
  latest: UsagePolicy | null;
  draft?: UsagePolicy;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // A new version is prefilled from the current one, since it is usually an
  // edit of the old rather than a fresh document.
  const source = draft ?? latest;
  const [title, setTitle] = useState(source?.title ?? 'Acceptable use policy');
  const [body, setBody] = useState(source?.body ?? '');
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const edited =
    title !== (source?.title ?? 'Acceptable use policy') || body !== (source?.body ?? '');

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      draft
        ? api.patch(`/admin/policies/${draft.id}`, payload)
        : api.post('/admin/policies', payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] });
      onClose();
    },
    onError: (cause) =>
      setError(apiErrorMessage(cause, 'The policy could not be saved.', POLICY_LABELS)),
  });
  // The error is about the values sent; correcting them clears it (#217).
  useClearOnEdit({ title, body, publish }, () => setError(null));

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = draft
      ? updatePolicyDraftSchema.safeParse({ title, body })
      : upsertUsagePolicySchema.safeParse({ title, body, publish });
    if (!parsed.success) {
      setError(validationText(parsed.error.issues, 'Check the policy fields.', POLICY_LABELS));
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{draft ? `Edit draft v${draft.version}` : 'New policy version'}</DialogTitle>
        <DialogDescription>
          {draft
            ? 'Nobody has been asked to accept this draft yet, so its wording can still change.'
            : 'Publishing asks everyone to accept again, including people who accepted an earlier version.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Title" htmlFor="policy-title">
          <Input
            id="policy-title"
            value={title}
            maxLength={160}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field
          label="Policy text"
          htmlFor="policy-body"
          hint="Shown in full before anyone can use the instance."
        >
          <Textarea
            id="policy-body"
            rows={14}
            value={body}
            required
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>

        {!draft && (
          <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
            <div>
              <label htmlFor="policy-publish" className="font-medium text-sm">
                Publish immediately
              </label>
              <p className="mt-0.5 text-[var(--text-muted)] text-xs">
                Turn off to save a draft that nobody is asked to accept yet.
              </p>
            </div>
            <Switch id="policy-publish" checked={publish} onCheckedChange={setPublish} />
          </div>
        )}

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
            {draft ? 'Save draft' : publish ? 'Publish version' : 'Save draft'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** The full wording of any version, for admins and auditors alike. */
function ViewPolicyDialog({ policy, onClose }: { policy: UsagePolicy; onClose: () => void }) {
  return (
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>
          {policy.title} (v{policy.version})
        </DialogTitle>
        <DialogDescription>
          {policy.publishedAt
            ? `Published ${formatDate(policy.publishedAt)} · accepted by ${policy.acceptanceCount}`
            : 'Draft: nobody has been asked to accept it yet.'}
        </DialogDescription>
      </DialogHeader>
      <div className="whitespace-pre-wrap rounded-xl border border-[var(--border-subtle)] p-4 text-sm">
        {policy.body}
      </div>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function AdminPoliciesPage() {
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState<UsagePolicy | null>(null);
  const [editing, setEditing] = useState<UsagePolicy | null>(null);
  const [deleting, setDeleting] = useState<UsagePolicy | null>(null);
  const [publishing, setPublishing] = useState<UsagePolicy | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] });

  const policiesQuery = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: () => api.get<{ policies: UsagePolicy[] }>('/admin/policies'),
  });
  const { data, isLoading } = policiesQuery;

  const policies = data?.policies ?? [];
  const current = policies.find((policy) => policy.publishedAt) ?? null;

  return (
    <div>
      <AdminPageHeader
        title="Acceptable use"
        description="A policy people must accept before using this instance. Each change is a new version, so a record of who accepted which wording is preserved."
        actions={
          <EditOnly>
            <Button variant="primary" onClick={() => setComposing(true)}>
              <FileText />
              New version
            </Button>
          </EditOnly>
        }
      />

      <div className="flex flex-col gap-6 pb-10">
        {policiesQuery.isError && !data && (
          <LoadError title="Policies could not be loaded." query={policiesQuery} />
        )}

        {!isLoading && data && policies.length === 0 && (
          <EmptyState icon={FileText} title="No policy has been published.">
            Until one is published, nobody is asked to accept anything.
          </EmptyState>
        )}

        {isLoading && <Spinner className="mx-auto size-6" />}

        {policies.length > 0 && (
          <RowList>
            {policies.map((policy) => (
              // On a phone the actions sit below the title: side by side, the
              // non-shrinking actions took the whole width and the title
              // collapsed to nothing while Publish ran out of the card (#168).
              <Row
                key={policy.id}
                className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate font-medium">{policy.title}</p>
                    <Badge variant="neutral">v{policy.version}</Badge>
                    {policy.id === current?.id ? (
                      <Badge variant="accent">in force</Badge>
                    ) : policy.publishedAt ? (
                      <Badge variant="outline">superseded</Badge>
                    ) : (
                      <Badge variant="outline">draft</Badge>
                    )}
                  </div>
                  <p className="text-[var(--text-muted)] text-xs">
                    {policy.publishedAt
                      ? `Published ${formatDate(policy.publishedAt)}`
                      : 'Not published'}
                    {` · accepted by ${policy.acceptanceCount}`}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`View ${policy.title} v${policy.version}`}
                    onClick={() => setViewing(policy)}
                  >
                    <Eye />
                    View
                  </Button>
                  {!policy.publishedAt && (
                    <EditOnly>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit draft ${policy.title} v${policy.version}`}
                        onClick={() => setEditing(policy)}
                      >
                        <Pencil />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Delete draft ${policy.title} v${policy.version}`}
                        onClick={() => setDeleting(policy)}
                      >
                        <Trash2 />
                        Delete
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        // Named for its version, as View, Edit and Delete are (#175).
                        aria-label={`Publish ${policy.title} v${policy.version}`}
                        onClick={() => setPublishing(policy)}
                      >
                        <Send />
                        Publish
                      </Button>
                    </EditOnly>
                  )}
                </div>
              </Row>
            ))}
          </RowList>
        )}

        <Notice title="Versions are kept, not edited">
          An acceptance records agreement to specific wording, so a published version is never
          changed in place and cannot be deleted once somebody has accepted it. Publishing a new
          version asks everyone to accept again.
        </Notice>
      </div>

      <Dialog open={composing} onOpenChange={(open) => !open && setComposing(false)}>
        {composing && <PolicyDialog latest={current} onClose={() => setComposing(false)} />}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <PolicyDialog latest={current} draft={editing} onClose={() => setEditing(null)} />
        )}
      </Dialog>

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        {viewing && <ViewPolicyDialog policy={viewing} onClose={() => setViewing(null)} />}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete draft v${deleting?.version ?? ''}?`}
        description={`"${deleting?.title ?? ''}" has not been published, so nobody has accepted it. Deleting it cannot be undone.`}
        confirmLabel="Delete draft"
        pendingLabel="Deleting…"
        errorMessage="The draft could not be deleted."
        onConfirm={async () => {
          if (deleting) await api.delete(`/admin/policies/${deleting.id}`);
          await refresh();
        }}
      />

      <ConfirmDialog
        open={publishing !== null}
        onOpenChange={(open) => !open && setPublishing(null)}
        title={`Publish v${publishing?.version ?? ''}?`}
        description="Everyone, including people who accepted an earlier version, must accept this wording before they can use the instance again. A published version cannot be changed or withdrawn."
        confirmLabel="Publish"
        pendingLabel="Publishing…"
        errorMessage="The policy could not be published."
        onConfirm={async () => {
          if (publishing) await api.post(`/admin/policies/${publishing.id}/publish`);
          await refresh();
        }}
      />
    </div>
  );
}

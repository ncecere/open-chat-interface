import {
  type PolicyAcceptances,
  type UsagePolicy,
  updatePolicyDraftSchema,
  upsertUsagePolicySchema,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileText, Pencil, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
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
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';
import { formatDate, formatDateTime } from '~/lib/utils';
import { validationProblems } from '~/lib/validation-issues';

/** The form's names for the fields, as errors should use them (#228). */
const POLICY_LABELS = { title: 'Title', body: 'Policy text' };

/**
 * Writes a new version, or rewords a draft (`draft`). A published version is
 * never edited: people may have accepted its wording.
 */
function PolicyDialog({
  latest,
  draft,
  nextVersion,
  onClose,
}: {
  latest: UsagePolicy | null;
  draft?: UsagePolicy;
  /** The number a new version will get, for the confirmation. */
  nextVersion: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // A new version is prefilled from the current one, since it is usually an
  // edit of the old rather than a fresh document.
  const source = draft ?? latest;
  const [title, setTitle] = useState(source?.title ?? 'Acceptable use policy');
  const [body, setBody] = useState(source?.body ?? '');
  // Off by default (#371): publishing cannot be undone and asks everyone to
  // accept again, so saving a draft is the safe default and publishing is
  // chosen, and confirmed, each time.
  const [publish, setPublish] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Each problem under its field, which is marked invalid and described by
  // it, until that field is edited; only one about no field (a failed save)
  // at the foot (#283, #322). A read-only refusal goes once changes are
  // accepted again (#308).
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems({ title, body, publish }, form);
  const at = (field: keyof typeof POLICY_LABELS) => problemsAt(problems, field);
  const error = problemsElsewhere(problems, Object.keys(POLICY_LABELS));
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
    onError: (cause) => {
      // Back to the form, where the problem is shown under its field.
      setConfirming(false);
      setProblems(apiErrorProblems(cause, 'The policy could not be saved.', POLICY_LABELS));
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);

    const parsed = draft
      ? updatePolicyDraftSchema.safeParse({ title, body })
      : upsertUsagePolicySchema.safeParse({ title, body, publish });
    if (!parsed.success) {
      const found: FieldProblem[] = validationProblems(parsed.error.issues, POLICY_LABELS).map(
        ({ field, text }) => ({ fields: field ? [field] : [], text }),
      );
      setProblems(found.length > 0 ? found : [{ fields: [], text: 'Check the policy fields.' }]);
      return;
    }
    // Publishing from here asks first, as publishing a draft from the list does.
    if (!draft && publish && !confirming) {
      setConfirming(true);
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

      <form noValidate onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Title" htmlFor="policy-title" error={at('title')}>
          <Input
            id="policy-title"
            {...invalidFieldProps('policy-title', at('title'))}
            value={title}
            maxLength={160}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field
          label="Policy text"
          htmlFor="policy-body"
          error={at('body')}
          hint="Shown in full before anyone can use the instance."
        >
          <Textarea
            id="policy-body"
            {...invalidFieldProps('policy-body', at('body'))}
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
              <p id="policy-publish-hint" className="mt-0.5 text-[var(--text-muted)] text-xs">
                Off saves a draft that nobody is asked to accept yet. On asks everyone to accept
                this wording, and can never be undone; you are asked to confirm first.
              </p>
            </div>
            <Switch
              id="policy-publish"
              aria-describedby="policy-publish-hint"
              checked={publish}
              onCheckedChange={setPublish}
            />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-[var(--danger-on-tint)] text-xs"
          >
            {error}
          </p>
        )}

        {confirming && (
          <div
            role="alert"
            className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-3 text-sm"
          >
            <p className="font-medium">
              Publish “{title.trim()}” as version {nextVersion}?
            </p>
            <p className="mt-1 text-[var(--text-secondary)]">
              Everyone, including people who accepted an earlier version, must accept this wording
              before they can use the instance again. A published version cannot be changed or
              withdrawn.
            </p>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Back
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {draft
              ? 'Save draft'
              : confirming
                ? `Publish version ${nextVersion}`
                : publish
                  ? 'Publish version…'
                  : 'Save draft'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * "accepted by 12", and "accepted by 12, 3 since deleted" when accounts that
 * accepted have been deleted since (#373): their acceptance goes with them, and
 * the count used to drop without saying so.
 */
export function acceptedText(
  policy: Pick<UsagePolicy, 'acceptanceCount' | 'deletedAcceptanceCount'>,
) {
  const deleted = policy.deletedAcceptanceCount ?? 0;
  return `accepted by ${policy.acceptanceCount}${deleted > 0 ? `, ${deleted} since deleted` : ''}`;
}

/** Who accepted a published version, with their email and when (#373). */
function AcceptanceList({ policy }: { policy: UsagePolicy }) {
  const acceptances = useQuery({
    queryKey: ['admin', 'policies', policy.id, 'acceptances'],
    queryFn: () => api.get<PolicyAcceptances>(`/admin/policies/${policy.id}/acceptances`),
  });
  const data = acceptances.data;

  return (
    <section aria-labelledby="policy-acceptances-heading">
      <h3 id="policy-acceptances-heading" className="font-medium text-sm">
        Who accepted
      </h3>
      {acceptances.isError && !data && (
        <LoadError title="Acceptances could not be loaded." query={acceptances} />
      )}
      {acceptances.isLoading && <Spinner className="mt-2 size-4" />}
      {data && (
        <>
          <p className="mt-1 text-[var(--text-muted)] text-xs">
            {data.accepted} accepted{data.deleted > 0 ? `, ${data.deleted} since deleted` : ''}.
            {data.deleted > 0 &&
              ' An acceptance goes with its account; the deleted ones are listed from the audit log.'}
            {data.shown < data.accepted + data.deleted &&
              ` Showing the latest ${data.shown}; the audit log (policy.accept) has the rest.`}
          </p>
          {data.acceptances.length === 0 ? (
            <p className="mt-2 text-[var(--text-muted)] text-sm">Nobody has accepted it yet.</p>
          ) : (
            <ul className="mt-2 max-h-56 divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-xl border border-[var(--border-subtle)] text-sm">
              {data.acceptances.map((entry) => (
                <li
                  key={`${entry.email}-${entry.acceptedAt}-${entry.accountDeleted}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
                >
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {entry.email ?? 'Unknown address'}
                    {entry.name && entry.name !== entry.email && (
                      <span className="text-[var(--text-muted)]"> · {entry.name}</span>
                    )}
                  </span>
                  {entry.accountDeleted && <Badge variant="outline">account deleted</Badge>}
                  <span
                    className="ml-auto shrink-0 text-[var(--text-muted)] text-xs"
                    title={entry.acceptedAt}
                  >
                    {formatDateTime(entry.acceptedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
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
            ? `Published ${formatDate(policy.publishedAt)} · ${acceptedText(policy)}`
            : 'Draft: nobody has been asked to accept it yet.'}
        </DialogDescription>
      </DialogHeader>
      <div className="whitespace-pre-wrap rounded-xl border border-[var(--border-subtle)] p-4 text-sm">
        {policy.body}
      </div>
      {policy.publishedAt && <AcceptanceList policy={policy} />}
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
  const nextVersion = Math.max(0, ...policies.map((policy) => policy.version)) + 1;

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
            {policies.map((policy) => {
              // A draft older than the version in force would be published for
              // good and shown to nobody, so it is not offered (#372).
              const olderDraft =
                !policy.publishedAt && current !== null && policy.version < current.version;
              return (
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
                      {` · ${acceptedText(policy)}`}
                    </p>
                    {olderDraft && (
                      <p className="mt-0.5 text-[var(--text-muted)] text-xs">
                        Older than v{current?.version}, which is in force, so it cannot be
                        published. Delete it, or write a new version.
                      </p>
                    )}
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
                        {!olderDraft && (
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
                        )}
                      </EditOnly>
                    )}
                  </div>
                </Row>
              );
            })}
          </RowList>
        )}

        <Notice title="Versions are kept, not edited">
          An acceptance records agreement to specific wording, so a published version can never be
          changed or deleted, even before anybody has accepted it. Publishing a new version asks
          everyone to accept again.
        </Notice>
      </div>

      <Dialog open={composing} onOpenChange={(open) => !open && setComposing(false)}>
        {composing && (
          <PolicyDialog
            latest={current}
            nextVersion={nextVersion}
            onClose={() => setComposing(false)}
          />
        )}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <PolicyDialog
            latest={current}
            draft={editing}
            nextVersion={nextVersion}
            onClose={() => setEditing(null)}
          />
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
        title={`Publish “${publishing?.title ?? ''}” as v${publishing?.version ?? ''}?`}
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

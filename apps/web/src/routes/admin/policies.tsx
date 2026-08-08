import { type UsagePolicy, upsertUsagePolicySchema } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Send } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AdminPageHeader, EmptyState, Notice, Row, RowList } from '~/components/admin/admin-ui';
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
import { ApiError, api } from '~/lib/api-client';

function PolicyDialog({ latest, onClose }: { latest: UsagePolicy | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  // Prefilled from the current version, since a new one is usually an edit of
  // the old rather than a fresh document.
  const [title, setTitle] = useState(latest?.title ?? 'Acceptable use policy');
  const [body, setBody] = useState(latest?.body ?? '');
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post('/admin/policies', payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] });
      onClose();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : 'The policy could not be saved.'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = upsertUsagePolicySchema.safeParse({ title, body, publish });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the policy fields.');
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>New policy version</DialogTitle>
        <DialogDescription>
          Publishing asks everyone to accept again, including people who accepted an earlier
          version.
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

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-[var(--danger-foreground)] text-xs"
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
            {publish ? 'Publish version' : 'Save draft'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function AdminPoliciesPage() {
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'policies'],
    queryFn: () => api.get<{ policies: UsagePolicy[] }>('/admin/policies'),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.post(`/admin/policies/${id}/publish`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'policies'] }),
  });

  const policies = data?.policies ?? [];
  const current = policies.find((policy) => policy.publishedAt) ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminPageHeader
        title="Acceptable use"
        description="A policy people must accept before using this instance. Each change is a new version, so a record of who accepted which wording is preserved."
        actions={
          <Button variant="primary" onClick={() => setComposing(true)}>
            <FileText />
            New version
          </Button>
        }
      />

      <div className="flex flex-col gap-6 pb-10">
        {!isLoading && policies.length === 0 && (
          <EmptyState icon={FileText} title="No policy has been published.">
            Until one is published, nobody is asked to accept anything.
          </EmptyState>
        )}

        {isLoading && <Spinner className="mx-auto size-6" />}

        {policies.length > 0 && (
          <RowList>
            {policies.map((policy) => (
              <Row key={policy.id}>
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
                      ? `Published ${new Date(policy.publishedAt).toLocaleDateString()}`
                      : 'Not published'}
                    {` · accepted by ${policy.acceptanceCount}`}
                  </p>
                </div>

                {!policy.publishedAt && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={publish.isPending}
                    onClick={() => publish.mutate(policy.id)}
                  >
                    <Send />
                    Publish
                  </Button>
                )}
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
    </div>
  );
}

import type { WebhookEndpoint } from '@oci/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Webhook } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, EmptyState, LoadError, Notice } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { EndpointCard } from './webhooks/endpoint-card';
import { SecretDialog } from './webhooks/secret-dialog';
import { WebhookFormDialog } from './webhooks/webhook-form-dialog';
import { WEBHOOKS_QUERY_KEY } from './webhooks/webhook-helpers';

export {
  parseActions,
  unmatchedActions,
  WEBHOOKS_QUERY_KEY,
  webhookChanges,
} from './webhooks/webhook-helpers';

/**
 * Tools & integrations → Webhooks: HTTPS endpoints that receive selected
 * audit events, signed with HMAC-SHA256 and retried with backoff.
 */
export function AdminWebhooksPage() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ endpoint: WebhookEndpoint | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<WebhookEndpoint | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const webhooks = useQuery({
    queryKey: WEBHOOKS_QUERY_KEY,
    queryFn: () => api.get<{ webhooks: WebhookEndpoint[] }>('/admin/webhooks'),
  });
  const actions = useQuery({
    queryKey: ['admin', 'audit', 'actions'],
    queryFn: () => api.get<{ actions: string[] }>('/admin/audit/actions'),
  });

  async function remove(endpoint: WebhookEndpoint) {
    await api.delete(`/admin/webhooks/${endpoint.id}`);
    await queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY_KEY });
  }

  return (
    <div>
      <AdminPageHeader
        title="Webhooks"
        description="Send selected audit events to your own systems as they happen. Each request is signed with HMAC-SHA256 and retried with backoff; payloads carry the audit entry’s metadata, never conversation content."
        actions={
          <EditOnly>
            <Button variant="secondary" onClick={() => setFormFor({ endpoint: null })}>
              <Plus />
              Add endpoint
            </Button>
          </EditOnly>
        }
      />
      <div className="flex flex-col gap-4">
        {webhooks.isLoading ? (
          <div className="py-8" role="status" aria-label="Loading webhooks">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : webhooks.isError || !webhooks.data ? (
          <LoadError title="Webhooks could not be loaded." query={webhooks} />
        ) : webhooks.data.webhooks.length === 0 ? (
          <EmptyState icon={Webhook} title="No webhook endpoints yet.">
            Add an HTTPS endpoint and choose the audit actions it receives, such as user.* or
            backup.run.
          </EmptyState>
        ) : (
          webhooks.data.webhooks.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              onEdit={() => setFormFor({ endpoint })}
              onDelete={() => setDeleteFor(endpoint)}
              onSecret={setSecret}
            />
          ))
        )}
        <Notice title="Verifying requests">
          Each request carries <code>OCI-Webhook-Timestamp</code> and{' '}
          <code>OCI-Webhook-Signature: v1=&lt;hex&gt;</code>, the HMAC-SHA256 of{' '}
          <code>timestamp.body</code> with the endpoint’s secret. Reject requests whose timestamp is
          more than five minutes old, and deduplicate by the payload’s <code>id</code>.
        </Notice>
      </div>

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <WebhookFormDialog
            endpoint={formFor.endpoint}
            knownActions={actions.data?.actions ?? []}
            onClose={() => setFormFor(null)}
            onCreated={(created) => setSecret(created.secret)}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(secret)} onOpenChange={(open) => !open && setSecret(null)}>
        {secret && <SecretDialog secret={secret} onClose={() => setSecret(null)} />}
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title="Delete this webhook endpoint?"
        description={
          deleteFor
            ? `${deleteFor.url} stops receiving events, and its delivery log and ${deleteFor.pendingDeliveries} pending deliver${deleteFor.pendingDeliveries === 1 ? 'y' : 'ies'} are removed. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete endpoint"
        pendingLabel="Deleting…"
        errorMessage="The endpoint could not be deleted."
        onConfirm={() => (deleteFor ? remove(deleteFor) : Promise.resolve())}
      />
    </div>
  );
}

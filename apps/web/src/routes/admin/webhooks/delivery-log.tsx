import type { WebhookDelivery, WebhookEndpoint } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { LoadError } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import { WEBHOOKS_QUERY_KEY } from './webhook-helpers';

export function DeliveryLog({ endpoint }: { endpoint: WebhookEndpoint }) {
  const log = useQuery({
    queryKey: [...WEBHOOKS_QUERY_KEY, endpoint.id, 'deliveries'],
    queryFn: () =>
      api.get<{ deliveries: WebhookDelivery[] }>(`/admin/webhooks/${endpoint.id}/deliveries`),
  });
  if (log.isLoading)
    return (
      <div role="status" aria-label="Loading deliveries">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  if (!log.data) return <LoadError title="Deliveries could not be loaded." query={log} />;
  if (log.data.deliveries.length === 0)
    return <p className="text-sm text-[var(--text-muted)]">Nothing delivered yet.</p>;
  return (
    <section
      // On narrow screens the log scrolls sideways; keyboard users must be able to scroll it too.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access (WCAG 2.1.1)
      tabIndex={0}
      aria-label={`Recent deliveries to ${endpoint.url}`}
      className="overflow-x-auto rounded-md"
    >
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Recent deliveries to {endpoint.url}</caption>
        <thead className="text-[var(--text-muted)]">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Event
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Attempts
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Last attempt
            </th>
            <th scope="col" className="py-1 font-medium">
              Result
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {log.data.deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td className="py-1.5 pr-3 font-mono">{delivery.event}</td>
              <td className="py-1.5 pr-3">
                <Badge
                  variant={
                    delivery.status === 'succeeded'
                      ? 'success'
                      : delivery.status === 'failed'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {delivery.status === 'pending' && delivery.attempts > 0
                    ? 'retrying'
                    : delivery.status}
                </Badge>
              </td>
              <td className="py-1.5 pr-3">
                {delivery.attempts} of {delivery.maxAttempts}
              </td>
              <td className="py-1.5 pr-3">
                {delivery.lastAttemptAt ? formatRelativeTime(delivery.lastAttemptAt) : '—'}
              </td>
              <td className="py-1.5">
                {delivery.lastError ??
                  (delivery.lastStatusCode ? `HTTP ${delivery.lastStatusCode}` : '')}
                {delivery.status === 'pending' && delivery.nextAttemptAt
                  ? ` · next ${formatRelativeTime(delivery.nextAttemptAt)}`
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

import type {
  AdminConnector,
  ConnectorRefreshResult,
  ConnectorTestResult,
  ConnectorTool,
  ToolKind,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditableFieldset, EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Notice,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { AUTH_MODE_LABELS, ConnectorFormDialog } from '~/components/admin/connector-form-dialog';
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
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';
import { CONNECT_OUTCOMES, startConnecting } from '~/lib/connectors';
import { formatDateTime } from '~/lib/utils';

export const CONNECTORS_QUERY_KEY = ['admin', 'connectors'] as const;

const KIND_OPTIONS = [
  { value: 'read', label: 'Read — runs without asking' },
  { value: 'write', label: 'Write — asks for approval' },
];

/**
 * What deleting a connector removes, naming only what it has: "Its 0 tools,
 * every role's allow for them and 0 connected accounts" said nothing (#182).
 */
export function connectorDeleteText(connector: Pick<AdminConnector, 'tools' | 'accountCount'>) {
  const tools = connector.tools.length;
  const accounts = connector.accountCount;
  const parts = [
    ...(tools > 0
      ? [
          `its ${tools} tool${tools === 1 ? '' : 's'} (and every role’s permission to use ${tools === 1 ? 'it' : 'them'})`,
        ]
      : []),
    ...(accounts > 0 ? [`its ${accounts} connected account${accounts === 1 ? '' : 's'}`] : []),
  ];
  if (parts.length === 0) return 'It has no tools or connected accounts. This cannot be undone.';
  const removed = parts.join(' and ');
  return `${removed.charAt(0).toUpperCase()}${removed.slice(1)} will be removed. This cannot be undone.`;
}

const when = (iso: string | null) => (iso ? formatDateTime(iso) : null);

function ToolRow({ connector, tool }: { connector: AdminConnector; tool: ConnectorTool }) {
  const queryClient = useQueryClient();
  const [confirmRead, setConfirmRead] = useState(false);
  const update = useMutation({
    mutationFn: (body: { enabled?: boolean; kind?: ToolKind; confirmReadOnly?: boolean }) =>
      api.patch(`/admin/connectors/${connector.id}/tools/${tool.id}`, body),
    onSuccess: async () => {
      setConfirmRead(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] }),
      ]);
    },
  });
  const id = `connector-tool-${tool.id}`;
  const label = tool.title || tool.name;
  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          {tool.title && <code className="text-xs text-[var(--text-muted)]">{tool.name}</code>}
          {tool.missing && <Badge variant="warning">no longer listed</Badge>}
          {tool.kind === 'read' && tool.serverKind === 'write' && (
            <Badge variant="warning">read by your choice</Badge>
          )}
        </div>
        {tool.description && (
          <p className="mt-1 max-w-2xl text-xs text-[var(--text-muted)]">{tool.description}</p>
        )}
        <MutationError
          error={update.error}
          message={`${label} could not be changed.`}
          className="mt-1"
        />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="w-56">
          <Select
            aria-label={`Kind of ${label}`}
            value={tool.kind}
            onChange={(next) => {
              if (next === 'read' && tool.serverKind === 'write') setConfirmRead(true);
              else update.mutate({ kind: next as ToolKind });
            }}
            options={KIND_OPTIONS}
          />
        </div>
        <Switch
          id={id}
          aria-label={`Enable ${label}`}
          checked={tool.enabled}
          disabled={tool.missing && !tool.enabled}
          onCheckedChange={(enabled) => update.mutate({ enabled })}
        />
      </div>
      <Dialog open={confirmRead} onOpenChange={setConfirmRead}>
        {confirmRead && (
          <DialogContent className="w-[calc(100%-2rem)] max-w-md">
            <DialogHeader>
              <DialogTitle>Run {label} without approval?</DialogTitle>
              <DialogDescription>
                {connector.name} does not declare this tool read-only. Read tools run without asking
                the person, so only do this if you know it never changes anything.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirmRead(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={update.isPending}
                onClick={() => update.mutate({ kind: 'read', confirmReadOnly: true })}
              >
                {update.isPending && <Spinner />}
                Mark as read
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </li>
  );
}

function ConnectorCard({
  connector,
  onEdit,
  onDelete,
}: {
  connector: AdminConnector;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const test = useMutation({
    mutationFn: () => api.post<ConnectorTestResult>(`/admin/connectors/${connector.id}/test`),
    // A test is a contact (or a failure): the row's "Last contact" follows (#84).
    onSettled: () => queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY }),
  });
  const refresh = useMutation({
    mutationFn: () => api.post<ConnectorRefreshResult>(`/admin/connectors/${connector.id}/refresh`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY }),
  });
  const connect = useMutation({ mutationFn: () => startConnecting(connector.id, 'admin') });
  const headingId = `connector-${connector.id}-heading`;
  const failing =
    connector.lastErrorAt &&
    (!connector.lastContactAt || connector.lastErrorAt > connector.lastContactAt);

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-[var(--border-subtle)] p-4"
      data-testid="connector"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="font-semibold">
              {connector.name}
            </h2>
            <Badge variant="neutral">{AUTH_MODE_LABELS[connector.authMode]}</Badge>
            {!connector.enabled && <Badge variant="warning">disabled</Badge>}
            {connector.allowPrivateNetwork && (
              <Badge variant="outline">private network allowed</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
            {connector.url}
            {connector.authMode === 'shared' &&
              ` · ${connector.sharedHeaderName} ${connector.hasSharedCredential ? 'set' : 'not set'}`}
            {connector.authMode === 'oauth' &&
              ` · ${connector.accountCount} connected · client ${
                connector.oauthClientId
                  ? connector.oauthClientSource === 'dynamic'
                    ? 'registered by OCI'
                    : connector.oauthClientId
                  : 'not registered yet'
              }`}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {connector.lastContactAt
              ? `Last contact ${when(connector.lastContactAt)}`
              : 'Not contacted yet'}
            {failing && (
              <span className="text-[var(--danger)]">
                {` · Last failure ${when(connector.lastErrorAt)}: ${connector.lastError}`}
              </span>
            )}
          </p>
        </div>
        <EditOnly>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending && <Spinner />}
              Test connection
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {refresh.isPending && <Spinner />}
              Refresh tools
            </Button>
            {connector.authMode === 'oauth' && connector.enabled && (
              <Button
                variant="secondary"
                size="sm"
                disabled={connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending && <Spinner />}
                Connect your account
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${connector.name}`}
              onClick={onEdit}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${connector.name}`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </div>
        </EditOnly>
      </div>

      <div aria-live="polite" className="mt-2 text-sm">
        {test.data && (
          <p className={test.data.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
            {test.data.ok ? 'Connection works. ' : 'Connection failed. '}
            {test.data.detail}
          </p>
        )}
        {refresh.data && (
          <p className="text-[var(--text-secondary)]">
            Tools refreshed: {refresh.data.added} new, {refresh.data.updated} updated,{' '}
            {refresh.data.missing} no longer listed.
          </p>
        )}
      </div>
      <MutationError error={test.error} message="The connection could not be tested." />
      <MutationError error={refresh.error} message="Tools could not be refreshed." />
      <MutationError error={connect.error} message="Could not start connecting your account." />

      <h3 className="mt-4 text-sm font-medium">Tools</h3>
      {connector.tools.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          No tools listed yet. Use Refresh tools to read them from the server.
        </p>
      ) : (
        <EditableFieldset>
          <ul className="divide-y divide-[var(--border-subtle)]">
            {connector.tools.map((tool) => (
              <ToolRow key={tool.id} connector={connector} tool={tool} />
            ))}
          </ul>
        </EditableFieldset>
      )}
    </section>
  );
}

/**
 * Connectors: remote MCP servers whose tools models may call. Tools start
 * disabled; each is enabled here and allowed per role on Roles & access.
 */
export function AdminConnectorsPage() {
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { connected?: string; error?: string };
  const [formFor, setFormFor] = useState<{ connector: AdminConnector | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<AdminConnector | null>(null);
  const connectors = useQuery({
    queryKey: CONNECTORS_QUERY_KEY,
    queryFn: () => api.get<{ connectors: AdminConnector[] }>('/admin/connectors'),
  });

  async function remove(connector: AdminConnector) {
    await api.delete(`/admin/connectors/${connector.id}`);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] }),
    ]);
  }

  return (
    <div>
      <AdminPageHeader
        title="Connectors"
        description="Remote MCP servers whose tools models can call during a reply. Tools stay off until you enable them here and allow them for a role in Roles & access. Write tools always ask the person to approve each call."
        actions={
          <EditOnly>
            <Button variant="secondary" onClick={() => setFormFor({ connector: null })}>
              <Plus />
              Add connector
            </Button>
          </EditOnly>
        }
      />

      <div className="flex flex-col gap-4">
        {search.connected && (
          <Notice title="Your account is connected">
            You can now refresh {search.connected}’s tools with your sign-in.
          </Notice>
        )}
        {search.error && CONNECT_OUTCOMES[search.error] && (
          <Notice tone="warning" title="Your account was not connected">
            {CONNECT_OUTCOMES[search.error]}
          </Notice>
        )}

        {connectors.isLoading ? (
          <div className="py-8" role="status" aria-label="Loading connectors">
            <Spinner className="mx-auto size-6" />
          </div>
        ) : connectors.isError || !connectors.data ? (
          <LoadError title="Connectors could not be loaded." query={connectors} />
        ) : connectors.data.connectors.length === 0 ? (
          <EmptyState icon={Plug} title="No connectors yet.">
            Add an MCP server, refresh its tools, enable the ones you want, then allow them for a
            role in Roles &amp; access.
          </EmptyState>
        ) : (
          <>
            {connectors.data.connectors.map((connector) => (
              <ConnectorCard
                key={connector.id}
                connector={connector}
                onEdit={() => setFormFor({ connector })}
                onDelete={() => setDeleteFor(connector)}
              />
            ))}
            <p className="text-sm text-[var(--text-muted)]">
              Enabled tools are off for every role until allowed in{' '}
              <Link to="/admin/roles" className="underline">
                Roles &amp; access
              </Link>
              .
            </p>
          </>
        )}
      </div>

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <ConnectorFormDialog connector={formFor.connector} onClose={() => setFormFor(null)} />
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? 'connector'}?`}
        description={deleteFor ? connectorDeleteText(deleteFor) : ''}
        confirmLabel="Delete connector"
        pendingLabel="Deleting…"
        errorMessage="The connector could not be deleted."
        onConfirm={() => (deleteFor ? remove(deleteFor) : Promise.resolve())}
      />
    </div>
  );
}

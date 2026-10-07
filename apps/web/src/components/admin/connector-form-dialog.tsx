import type { AdminConnector, ConnectorAuthMode } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useEditedSince } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import {
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
import { Switch } from '~/components/ui/switch';
import {
  type FieldProblem,
  linkFields,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';

export const AUTH_MODE_LABELS: Record<ConnectorAuthMode, string> = {
  none: 'No sign-in',
  shared: 'Shared credential',
  oauth: 'Each person signs in (OAuth)',
};

const AUTH_MODE_HINTS: Record<ConnectorAuthMode, string> = {
  none: 'For servers that need no credential.',
  shared:
    'OCI sends one credential, held encrypted, for everyone. The server sees every person as the same account.',
  oauth:
    'Each person connects their own account under Settings → Connectors, so the server applies their own permissions.',
};

type SecretAction = 'keep' | 'replace' | 'clear';

/** The form's names for the fields the API names differently (#127). */
const CONNECTOR_LABELS = {
  url: 'Server URL',
  slug: 'Short name',
  authMode: 'Authentication',
  sharedHeaderName: 'Header name',
  sharedHeaderValue: 'Header value',
  oauthClientId: 'Client ID',
  oauthClientSecret: 'Client secret',
  oauthScopes: 'Scopes',
};

/**
 * Fields whose problems another field also decides: a plain http:// URL is
 * refused only while "Allow private network" is off, so switching it on
 * clears the complaint, as correcting the URL does (#283).
 */
const LINKED_FIELDS = { url: ['allowPrivateNetwork'] };

/** Where authorization servers send people back, for registering an OAuth client. */
function connectorRedirectUrl(connector: AdminConnector | null): string {
  return connector?.oauthRedirectUrl ?? `${window.location.origin}/api/connectors/oauth/callback`;
}

/** Only the fields that differ from the stored connector, plus any secret change. Exported for tests. */
export function connectorChanges(
  saved: AdminConnector,
  draft: {
    name: string;
    url: string;
    authMode: ConnectorAuthMode;
    sharedHeaderName: string;
    oauthClientId: string;
    oauthScopes: string;
    enabled: boolean;
    allowPrivateNetwork: boolean;
  },
  secrets: { sharedHeaderValue: [SecretAction, string]; oauthClientSecret: [SecretAction, string] },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.name.trim() !== saved.name) patch.name = draft.name.trim();
  if (draft.url.trim() !== saved.url) patch.url = draft.url.trim();
  if (draft.authMode !== saved.authMode) patch.authMode = draft.authMode;
  if (draft.sharedHeaderName.trim() !== saved.sharedHeaderName)
    patch.sharedHeaderName = draft.sharedHeaderName.trim();
  const clientId = draft.oauthClientId.trim() || null;
  if (
    clientId !== saved.oauthClientId &&
    !(clientId === null && saved.oauthClientSource === 'dynamic')
  )
    patch.oauthClientId = clientId;
  if (draft.oauthScopes.trim() !== saved.oauthScopes) patch.oauthScopes = draft.oauthScopes.trim();
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  if (draft.allowPrivateNetwork !== saved.allowPrivateNetwork)
    patch.allowPrivateNetwork = draft.allowPrivateNetwork;
  for (const key of ['sharedHeaderValue', 'oauthClientSecret'] as const) {
    const [action, value] = secrets[key];
    if (action === 'clear') patch[key] = null;
    if (action === 'replace' && value) patch[key] = value;
  }
  return patch;
}

function SecretField({
  id,
  label,
  isSet,
  action,
  onAction,
  value,
  onValue,
  hint,
  placeholder,
  error,
}: {
  id: string;
  label: string;
  isSet: boolean;
  action: SecretAction;
  onAction: (action: SecretAction) => void;
  value: string;
  onValue: (value: string) => void;
  hint: string;
  placeholder: string;
  error: string | null;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={isSet ? `Set. ${hint}` : `Not set. ${hint}`}
      error={error}
    >
      <div className="flex flex-col gap-2">
        {isSet && (
          <Select
            aria-label={`${label} action`}
            value={action}
            onChange={(next) => onAction(next as SecretAction)}
            options={[
              { value: 'keep', label: 'Keep the stored value' },
              { value: 'replace', label: 'Replace it' },
              { value: 'clear', label: 'Remove it' },
            ]}
          />
        )}
        {(!isSet || action === 'replace') && (
          <Input
            id={id}
            {...invalidFieldProps(id, error)}
            type="password"
            autoComplete="off"
            value={value}
            placeholder={placeholder}
            onChange={(event) => onValue(event.target.value)}
          />
        )}
      </div>
    </Field>
  );
}

/**
 * Adds or edits a connector. Secrets are write-only: the form shows whether
 * one is set, never its value.
 */
export function ConnectorFormDialog({
  connector,
  onClose,
}: {
  connector: AdminConnector | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(connector?.name ?? '');
  const [url, setUrl] = useState(connector?.url ?? '');
  const [slug, setSlug] = useState('');
  const [authMode, setAuthMode] = useState<ConnectorAuthMode>(connector?.authMode ?? 'none');
  const [headerName, setHeaderName] = useState(connector?.sharedHeaderName ?? 'Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [headerAction, setHeaderAction] = useState<SecretAction>('keep');
  const [clientId, setClientId] = useState(
    connector?.oauthClientSource === 'manual' ? (connector.oauthClientId ?? '') : '',
  );
  const [clientSecret, setClientSecret] = useState('');
  const [secretAction, setSecretAction] = useState<SecretAction>('keep');
  const [scopes, setScopes] = useState(connector?.oauthScopes ?? '');
  const [enabled, setEnabled] = useState(connector?.enabled ?? true);
  const [allowPrivate, setAllowPrivate] = useState(connector?.allowPrivateNetwork ?? false);
  // The values sent, by the API's names for them, so each error the API
  // returns is shown under its field and goes when that field is corrected,
  // and every problem is listed at once (#217, #283).
  const values = {
    name,
    url,
    slug,
    authMode,
    sharedHeaderName: headerName,
    sharedHeaderValue: headerValue,
    headerAction,
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    secretAction,
    oauthScopes: scopes,
    enabled,
    allowPrivateNetwork: allowPrivate,
  };
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems(values, form);
  // Escape or a click outside asks before throwing edits away (#45, #300).
  const edited = useEditedSince(values);
  const report = (found: FieldProblem[]) => setProblems(linkFields(found, LINKED_FIELDS));
  const at = (field: keyof typeof values) => problemsAt(problems, field);
  // The fields on screen; an error about any other is shown at the foot.
  const shown = [
    'name',
    'url',
    ...(connector ? [] : ['slug']),
    ...(authMode === 'shared' ? ['sharedHeaderName', 'sharedHeaderValue'] : []),
    ...(authMode === 'oauth' ? ['oauthClientId', 'oauthClientSecret', 'oauthScopes'] : []),
  ];
  const error = problemsElsewhere(problems, shown);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      connector
        ? api.patch(`/admin/connectors/${connector.id}`, body)
        : api.post('/admin/connectors', body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'connectors'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] }),
      ]);
      onClose();
    },
    onError: (cause) =>
      report(apiErrorProblems(cause, 'The connector could not be saved.', CONNECTOR_LABELS)),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);
    // No check of its own first: the API reports a missing name or URL
    // together with the URL's network rule and the short name, so one save
    // lists every problem; stopping at the form's own check left the rest
    // for the next save (#301).
    if (connector) {
      const patch = connectorChanges(
        connector,
        {
          name,
          url,
          authMode,
          sharedHeaderName: headerName,
          oauthClientId: clientId,
          oauthScopes: scopes,
          enabled,
          allowPrivateNetwork: allowPrivate,
        },
        {
          sharedHeaderValue: [
            connector.hasSharedCredential ? headerAction : 'replace',
            headerValue,
          ],
          oauthClientSecret: [
            connector.hasOauthClientSecret ? secretAction : 'replace',
            clientSecret,
          ],
        },
      );
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      save.mutate(patch);
      return;
    }
    save.mutate({
      name: name.trim(),
      url: url.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      authMode,
      sharedHeaderName: headerName.trim() || 'Authorization',
      ...(authMode === 'shared' && headerValue ? { sharedHeaderValue: headerValue } : {}),
      ...(authMode === 'oauth' && clientId.trim() ? { oauthClientId: clientId.trim() } : {}),
      ...(authMode === 'oauth' && clientSecret ? { oauthClientSecret: clientSecret } : {}),
      oauthScopes: scopes.trim(),
      enabled,
      allowPrivateNetwork: allowPrivate,
    });
  }

  const changesConnections =
    connector &&
    (url.trim() !== connector.url ||
      authMode !== connector.authMode ||
      (connector.oauthClientSource === 'manual' &&
        (clientId.trim() || null) !== connector.oauthClientId)) &&
    connector.accountCount > 0;

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{connector ? `Edit ${connector.name}` : 'Add connector'}</DialogTitle>
        <DialogDescription>
          A remote MCP server (Streamable HTTP). Its tools stay off until you enable them and allow
          them for a role.
        </DialogDescription>
      </DialogHeader>

      <form ref={form} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Name"
          htmlFor="connector-name"
          hint="Shown to people next to its tools."
          error={at('name')}
        >
          <Input
            id="connector-name"
            {...invalidFieldProps('connector-name', at('name'))}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Server URL"
          htmlFor="connector-url"
          error={at('url')}
          hint="The MCP endpoint, for example https://mcp.example.com/mcp. Redirects are not followed."
        >
          <Input
            id="connector-url"
            {...invalidFieldProps('connector-url', at('url'))}
            value={url}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) => setUrl(event.target.value)}
            required
          />
        </Field>
        {!connector && (
          <Field
            label="Short name (optional)"
            htmlFor="connector-slug"
            error={at('slug')}
            hint="Used in tool ids; chosen from the name when empty and fixed once saved."
          >
            <Input
              id="connector-slug"
              {...invalidFieldProps('connector-slug', at('slug'))}
              value={slug}
              placeholder="docs"
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
        )}
        <Field label="Authentication" htmlFor="connector-auth" hint={AUTH_MODE_HINTS[authMode]}>
          <Select
            id="connector-auth"
            value={authMode}
            onChange={(next) => setAuthMode(next as ConnectorAuthMode)}
            options={(['none', 'shared', 'oauth'] as const).map((value) => ({
              value,
              label: AUTH_MODE_LABELS[value],
            }))}
          />
        </Field>

        {authMode === 'shared' && (
          <>
            <Field
              label="Header name"
              htmlFor="connector-header-name"
              error={at('sharedHeaderName')}
              hint="For example Authorization or X-Api-Key."
            >
              <Input
                id="connector-header-name"
                {...invalidFieldProps('connector-header-name', at('sharedHeaderName'))}
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
              />
            </Field>
            <SecretField
              id="connector-header-value"
              label="Header value"
              isSet={Boolean(connector?.hasSharedCredential)}
              action={headerAction}
              onAction={setHeaderAction}
              value={headerValue}
              onValue={setHeaderValue}
              hint="Stored encrypted and never shown again."
              placeholder="Bearer …"
              error={at('sharedHeaderValue')}
            />
          </>
        )}

        {authMode === 'oauth' && (
          <>
            <Field
              label="Client ID (optional)"
              htmlFor="connector-client-id"
              error={at('oauthClientId')}
              hint={
                connector?.oauthClientSource === 'dynamic'
                  ? `OCI registered itself with the server as ${connector.oauthClientId}. Enter a client ID to use your own instead.`
                  : 'Leave empty if the server lets OCI register itself.'
              }
            >
              <Input
                id="connector-client-id"
                {...invalidFieldProps('connector-client-id', at('oauthClientId'))}
                value={clientId}
                autoComplete="off"
                onChange={(event) => setClientId(event.target.value)}
              />
            </Field>
            <SecretField
              id="connector-client-secret"
              label="Client secret (optional)"
              isSet={Boolean(
                connector?.hasOauthClientSecret && connector.oauthClientSource === 'manual',
              )}
              action={secretAction}
              onAction={setSecretAction}
              value={clientSecret}
              onValue={setClientSecret}
              hint="Stored encrypted and never shown again."
              placeholder="Client secret"
              error={at('oauthClientSecret')}
            />
            <Field
              label="Scopes (optional)"
              htmlFor="connector-scopes"
              hint="Space-separated."
              error={at('oauthScopes')}
            >
              <Input
                id="connector-scopes"
                {...invalidFieldProps('connector-scopes', at('oauthScopes'))}
                value={scopes}
                onChange={(event) => setScopes(event.target.value)}
              />
            </Field>
            <Field
              label="Redirect URL"
              htmlFor="connector-redirect"
              hint="Register this with the server’s OAuth client."
            >
              <Input id="connector-redirect" value={connectorRedirectUrl(connector)} readOnly />
            </Field>
          </>
        )}

        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <label htmlFor="connector-enabled" className="text-sm font-medium">
              Enabled
            </label>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Disabling stops every tool of this connector.
            </p>
          </div>
          <Switch id="connector-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <label htmlFor="connector-private" className="text-sm font-medium">
              Allow private network
            </label>
            <p id="connector-private-hint" className="mt-0.5 text-xs text-[var(--text-muted)]">
              Allows plain http:// and private, loopback and link-local addresses. Only for servers
              you run on your own network.
            </p>
          </div>
          <Switch
            id="connector-private"
            aria-describedby="connector-private-hint"
            checked={allowPrivate}
            onCheckedChange={setAllowPrivate}
          />
        </div>

        {changesConnections && (
          <p role="status" className="text-xs text-[var(--warning)]">
            Saving disconnects the {connector.accountCount} people connected to it; they will have
            to connect again.
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
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
            {connector ? 'Save changes' : 'Add connector'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

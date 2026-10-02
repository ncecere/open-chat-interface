import {
  type EmbeddingsStatus,
  type EmbeddingsTestResult,
  MICROS_PER_DOLLAR,
  PGVECTOR_ENABLE_COMMAND,
  type UpdateEmbeddingsInput,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  LoadError,
  MutationError,
  Notice,
  SaveRow,
  SettingsSection,
} from '~/components/admin/admin-ui';
import { RerankingSection } from '~/components/admin/reranking-section';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

export const EMBEDDINGS_QUERY_KEY = ['admin', 'embeddings'] as const;

/** Operator documentation for enabling pgvector and moving off an Alpine image. */
export const PGVECTOR_DOCS_URL =
  'https://github.com/ncecere/open-chat-interface/blob/main/docs/OPERATIONS.md#upgrading-to-v09';

interface Draft {
  enabled: boolean;
  providerId: string;
  modelId: string;
  price: string;
}

function makeDraft(settings: EmbeddingsStatus['settings']): Draft {
  return {
    enabled: settings.enabled,
    providerId: settings.providerId ?? '',
    modelId: settings.modelId ?? '',
    price:
      settings.inputPriceMicros === null
        ? ''
        : (settings.inputPriceMicros / MICROS_PER_DOLLAR).toString(),
  };
}

function priceMicros(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * MICROS_PER_DOLLAR)
    : undefined;
}

/** Only what changed, so an unchanged model is never re-measured. */
export function embeddingsChanges(
  saved: EmbeddingsStatus['settings'],
  draft: Draft,
): UpdateEmbeddingsInput {
  const changes: UpdateEmbeddingsInput = {};
  const providerId = draft.providerId || null;
  const modelId = draft.modelId.trim() || null;
  const price = priceMicros(draft.price);
  if (draft.enabled !== saved.enabled) changes.enabled = draft.enabled;
  if (providerId !== saved.providerId) changes.providerId = providerId;
  if (modelId !== saved.modelId) changes.modelId = modelId;
  if (price !== undefined && price !== saved.inputPriceMicros) changes.inputPriceMicros = price;
  return changes;
}

/** Where pgvector stands, and what the operator needs to do about it. */
export function PgvectorNotice({ pgvector }: { pgvector: EmbeddingsStatus['pgvector'] }) {
  if (pgvector.state === 'enabled') {
    return (
      <Notice title={`pgvector ${pgvector.version ?? ''} is enabled`.replace('  ', ' ')}>
        The database can store embeddings. Open Chat Interface creates its table when meaning-based
        search is switched on.
      </Notice>
    );
  }
  const docs = (
    <a
      href={PGVECTOR_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--accent-bright)] hover:underline"
    >
      Upgrading to v0.9
    </a>
  );
  if (pgvector.state === 'available') {
    return (
      <Notice tone="warning" title="pgvector is installed but not enabled">
        <p>
          Project search stays keyword-only until a database owner or superuser enables the
          extension once. Open Chat Interface never does this itself:
        </p>
        <pre className="my-2 overflow-x-auto rounded-lg bg-[var(--bg-control)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
          <code>{PGVECTOR_ENABLE_COMMAND}</code>
        </pre>
        <p>See {docs} in the operations guide.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title="pgvector is not installed on the database server">
      <p>
        Project search stays keyword-only. Use a PostgreSQL image that includes pgvector (such as{' '}
        <code>pgvector/pgvector:pg17</code>), or build pgvector into your current image, then run{' '}
        <code>{PGVECTOR_ENABLE_COMMAND}</code>.
      </p>
      <p className="mt-2">
        Moving an existing Alpine-based PostgreSQL to a Debian-based image must be a dump and
        restore, not a reused data directory: differences in text collation can corrupt indexes. See{' '}
        {docs} in the operations guide.
      </p>
    </Notice>
  );
}

function Progress({ status }: { status: EmbeddingsStatus }) {
  if (!status.settings.enabled) return null;
  if (!status.active) {
    return (
      <p className="text-sm text-[var(--text-muted)]" data-embeddings-progress="waiting">
        {status.pgvector.state === 'enabled'
          ? 'Embedding storage is being prepared by the background job.'
          : 'Waiting for pgvector. Search stays keyword-only until it is enabled.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--text-secondary)]" data-embeddings-progress="active">
        Meaning-based search is on: {status.passages.embedded.toLocaleString()} of{' '}
        {status.passages.total.toLocaleString()} passages embedded ({status.storageDimensions}{' '}
        dimensions). The background job embeds the rest.
      </p>
      {status.failures.files > 0 && (
        <Notice tone="warning" title="Some files could not be embedded">
          {status.failures.files} {status.failures.files === 1 ? 'file is' : 'files are'} waiting to
          be retried. Last error: {status.failures.lastError ?? 'unknown'}
        </Notice>
      )}
    </div>
  );
}

function EmbeddingsForm({ status }: { status: EmbeddingsStatus }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => makeDraft(status.settings));
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(makeDraft(status.settings)), [status.settings]);

  const changes = embeddingsChanges(status.settings, draft);
  const hasChanges = Object.keys(changes).length > 0;
  const invalidPrice = priceMicros(draft.price) === undefined;

  const save = useMutation({
    mutationFn: (input: UpdateEmbeddingsInput) =>
      api.put<EmbeddingsStatus>('/admin/embeddings', input),
    onSuccess: (next) => {
      queryClient.setQueryData(EMBEDDINGS_QUERY_KEY, next);
      setSaved(true);
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<EmbeddingsTestResult>('/admin/embeddings/test', {
        ...(draft.providerId && { providerId: draft.providerId }),
        ...(draft.modelId.trim() && { modelId: draft.modelId.trim() }),
      }),
  });
  const edit = (patch: Partial<Draft>) => {
    setSaved(false);
    save.reset();
    test.reset();
    setDraft((current) => ({ ...current, ...patch }));
  };

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && !invalidPrice) save.mutate(changes);
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <label htmlFor="embeddings-enabled" className="text-sm font-medium">
            Search project files by meaning
          </label>
          <p id="embeddings-enabled-description" className="mt-1 text-xs text-[var(--text-muted)]">
            Finds passages that answer a question in other words, alongside keyword search. Needs
            pgvector.
          </p>
        </div>
        <Switch
          id="embeddings-enabled"
          checked={draft.enabled}
          disabled={save.isPending}
          aria-describedby="embeddings-enabled-description"
          onCheckedChange={(enabled) => edit({ enabled })}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Provider"
          htmlFor="embeddings-provider"
          hint={
            status.providers.length === 0
              ? 'Add an OpenAI, Google or OpenAI-compatible provider first. Anthropic has no embeddings.'
              : 'An existing provider. Anthropic has no embeddings.'
          }
        >
          <Select
            id="embeddings-provider"
            value={draft.providerId}
            disabled={save.isPending}
            placeholder="Select a provider"
            onChange={(providerId) => edit({ providerId })}
            options={status.providers.map((provider) => ({
              value: provider.id,
              label: provider.label,
            }))}
          />
        </Field>
        <Field
          label="Model id"
          htmlFor="embeddings-model"
          hint="The provider's embeddings model, such as text-embedding-3-small."
        >
          <Input
            id="embeddings-model"
            value={draft.modelId}
            placeholder="text-embedding-3-small"
            disabled={save.isPending}
            onChange={(event) => edit({ modelId: event.target.value })}
          />
        </Field>
        <Field
          label="Price"
          htmlFor="embeddings-price"
          hint={
            invalidPrice
              ? 'Enter a price of zero or more, or leave it blank.'
              : 'US dollars per million tokens. Leave blank to record usage at no cost.'
          }
        >
          <Input
            id="embeddings-price"
            type="number"
            min={0}
            step="0.01"
            value={draft.price}
            placeholder="0.02"
            aria-invalid={invalidPrice}
            disabled={save.isPending}
            onChange={(event) => edit({ price: event.target.value })}
          />
        </Field>
        <Field
          label="Dimensions"
          htmlFor="embeddings-dimensions"
          hint="Read from a test embedding."
        >
          <Input
            id="embeddings-dimensions"
            readOnly
            value={status.settings.dimensions?.toString() ?? 'Not measured yet'}
          />
        </Field>
      </div>

      <Progress status={status} />

      <EditOnly>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={test.isPending || !draft.providerId || !draft.modelId.trim()}
            onClick={() => test.mutate()}
          >
            {test.isPending && <Spinner />}
            Test model
          </Button>
          {test.data?.ok && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Works: {test.data.dimensions} dimensions.
            </p>
          )}
          {test.data && !test.data.ok && (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {test.data.message}
            </p>
          )}
          <MutationError error={test.error} message="The test could not be run." />
        </div>
      </EditOnly>

      <SaveRow
        hasChanges={hasChanges && !invalidPrice}
        isPending={save.isPending}
        errorMessage={
          save.error
            ? save.error instanceof ApiError
              ? save.error.message
              : 'The embeddings settings could not be saved.'
            : null
        }
        successMessage={saved ? 'Embeddings settings saved.' : null}
      />
    </form>
  );
}

/**
 * Providers & Models → Embeddings: meaning-based search for project files,
 * and optional reranking, which works with or without it.
 */
export function EmbeddingsSection() {
  return (
    <div className="flex flex-col gap-8">
      <EmbeddingsSettings />
      <RerankingSection />
    </div>
  );
}

function EmbeddingsSettings() {
  const status = useQuery({
    queryKey: EMBEDDINGS_QUERY_KEY,
    queryFn: () => api.get<EmbeddingsStatus>('/admin/embeddings'),
  });

  if (status.isLoading) {
    return (
      <div className="py-8" role="status" aria-label="Loading embeddings settings">
        <Spinner className="mx-auto size-6" />
      </div>
    );
  }
  if (status.isError || !status.data) {
    return <LoadError title="The embeddings settings could not be loaded." query={status} />;
  }
  return (
    <>
      <SettingsSection
        title="Database"
        description="Embeddings are stored in PostgreSQL with the pgvector extension, which an operator enables."
        editable={false}
      >
        <PgvectorNotice pgvector={status.data.pgvector} />
      </SettingsSection>
      <SettingsSection
        title="Embeddings model"
        description="Used to search large project files by meaning as well as by keyword. Each passage is embedded once; questions are embedded as they are asked. Both count towards the person's usage."
      >
        <EmbeddingsForm status={status.data} />
      </SettingsSection>
    </>
  );
}

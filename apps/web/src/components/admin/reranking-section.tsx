import {
  MICROS_PER_DOLLAR,
  type RerankingStatus,
  type RerankingTestResult,
  type UpdateRerankingInput,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { LoadError, MutationError, SaveRow, SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api, apiErrorMessage } from '~/lib/api-client';
import { priceMicros } from '~/lib/price';

const RERANKING_QUERY_KEY = ['admin', 'reranking'] as const;

interface RerankingDraft {
  enabled: boolean;
  providerId: string;
  modelId: string;
  price: string;
}

function makeDraft(settings: RerankingStatus['settings']): RerankingDraft {
  return {
    enabled: settings.enabled,
    providerId: settings.providerId ?? '',
    modelId: settings.modelId ?? '',
    price:
      settings.searchPriceMicros === null
        ? ''
        : (settings.searchPriceMicros / MICROS_PER_DOLLAR).toString(),
  };
}

/** Only what changed, so an unchanged model is never tested again. */
export function rerankingChanges(
  saved: RerankingStatus['settings'],
  draft: RerankingDraft,
): UpdateRerankingInput {
  const changes: UpdateRerankingInput = {};
  const providerId = draft.providerId || null;
  const modelId = draft.modelId.trim() || null;
  const price = priceMicros(draft.price);
  if (draft.enabled !== saved.enabled) changes.enabled = draft.enabled;
  if (providerId !== saved.providerId) changes.providerId = providerId;
  if (modelId !== saved.modelId) changes.modelId = modelId;
  if (price !== undefined && price !== saved.searchPriceMicros) changes.searchPriceMicros = price;
  return changes;
}

function RerankingForm({ status }: { status: RerankingStatus }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => makeDraft(status.settings));
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(makeDraft(status.settings)), [status.settings]);

  const changes = rerankingChanges(status.settings, draft);
  const hasChanges = Object.keys(changes).length > 0;
  useReportUnsaved(hasChanges);
  const invalidPrice = priceMicros(draft.price) === undefined;
  const endpoint = status.providers.find((provider) => provider.id === draft.providerId)?.endpoint;
  // Why Test reranking is unavailable, said beside it rather than left to guess (#157).
  const testBlocked = !draft.providerId
    ? 'Choose a provider to test reranking.'
    : !draft.modelId.trim()
      ? 'Enter a model id to test reranking.'
      : null;

  const save = useMutation({
    mutationFn: (input: UpdateRerankingInput) =>
      api.put<RerankingStatus>('/admin/reranking', input),
    onSuccess: (next) => {
      queryClient.setQueryData(RERANKING_QUERY_KEY, next);
      setSaved(true);
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<RerankingTestResult>('/admin/reranking/test', {
        ...(draft.providerId && { providerId: draft.providerId }),
        ...(draft.modelId.trim() && { modelId: draft.modelId.trim() }),
      }),
  });
  const edit = (patch: Partial<RerankingDraft>) => {
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
          <label htmlFor="reranking-enabled" className="text-sm font-medium">
            Rerank project search results
          </label>
          <p id="reranking-enabled-description" className="mt-1 text-xs text-[var(--text-muted)]">
            A reranking model reads the question with each of the best 40 passages and puts the ones
            that answer it first. Works with or without pgvector: without it, keyword results are
            reranked.
          </p>
        </div>
        <Switch
          id="reranking-enabled"
          checked={draft.enabled}
          disabled={save.isPending}
          aria-describedby="reranking-enabled-description"
          onCheckedChange={(enabled) => edit({ enabled })}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Provider"
          htmlFor="reranking-provider"
          hint={
            status.providers.length === 0
              ? 'Add an OpenAI-compatible provider (or an OpenAI provider with a base URL, such as a LiteLLM gateway) first.'
              : 'An OpenAI-compatible provider, or an OpenAI provider with a base URL.'
          }
        >
          <Select
            id="reranking-provider"
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
          htmlFor="reranking-model"
          hint="The provider's reranking model, such as bge-reranker-v2-m3 or rerank-v3.5."
        >
          <Input
            id="reranking-model"
            value={draft.modelId}
            placeholder="bge-reranker-v2-m3"
            disabled={save.isPending}
            onChange={(event) => edit({ modelId: event.target.value })}
          />
        </Field>
        <Field
          label="Price"
          htmlFor="reranking-price"
          hint={
            invalidPrice
              ? 'Enter a price of zero or more, or leave it blank.'
              : 'US dollars per 1,000 searches (reranked messages). Leave blank to record usage at no cost.'
          }
        >
          <Input
            id="reranking-price"
            type="number"
            min={0}
            step="0.01"
            value={draft.price}
            placeholder="2.00"
            aria-invalid={invalidPrice}
            disabled={save.isPending}
            onChange={(event) => edit({ price: event.target.value })}
          />
        </Field>
        <Field
          label="Endpoint"
          htmlFor="reranking-endpoint"
          hint="The provider's base URL with /rerank appended; it must accept Cohere-compatible requests."
        >
          <Input
            id="reranking-endpoint"
            readOnly
            // Empty until a provider is chosen: a placeholder, not a value that
            // reads as though it were the endpoint.
            value={endpoint ?? ''}
            placeholder="Shown once a provider is chosen"
            className="font-mono text-xs"
          />
        </Field>
      </div>

      {status.settings.enabled && (
        <p className="text-sm text-[var(--text-secondary)]" data-reranking-state>
          {status.active
            ? `Reranking is on with ${status.settings.modelId}.`
            : 'Reranking is switched on, but its provider is unavailable, so search results keep their order.'}
        </p>
      )}

      <EditOnly>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={test.isPending || testBlocked !== null}
            aria-describedby={testBlocked ? 'reranking-test-blocked' : undefined}
            onClick={() => test.mutate()}
          >
            {test.isPending && <Spinner />}
            Test reranking
          </Button>
          {testBlocked && (
            <p id="reranking-test-blocked" className="text-xs text-[var(--text-muted)]">
              {testBlocked}
            </p>
          )}
          {test.data?.ok && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Works: reranked a sample in {test.data.latencyMs} ms.
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
            ? apiErrorMessage(save.error, 'The reranking settings could not be saved.')
            : null
        }
        successMessage={saved ? 'Reranking settings saved.' : null}
      />
    </form>
  );
}

/** Providers & Models → Embeddings → Reranking: optional reranking of project search. */
export function RerankingSection() {
  const status = useQuery({
    queryKey: RERANKING_QUERY_KEY,
    queryFn: () => api.get<RerankingStatus>('/admin/reranking'),
  });

  return (
    <SettingsSection
      title="Reranking"
      description="Optional. Reorders the best project search results with a reranking model before passages are chosen. Each reranked message counts towards the person's usage."
      editable={Boolean(status.data)}
    >
      {status.isLoading ? (
        <div className="py-8" role="status" aria-label="Loading reranking settings">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : status.isError || !status.data ? (
        <LoadError title="The reranking settings could not be loaded." query={status} />
      ) : (
        <RerankingForm status={status.data} />
      )}
    </SettingsSection>
  );
}

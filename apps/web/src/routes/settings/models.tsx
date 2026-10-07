import {
  type CatalogModel,
  effectiveSupportedEfforts,
  type ModelCapability,
  type ReasoningEffort,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Brain, CheckCircle2, Eye, FileText, Image, Wrench, Zap } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useModels } from '~/hooks/use-models';
import { api, apiErrorMessage } from '~/lib/api-client';

const CAPABILITY_META: Partial<Record<ModelCapability, { label: string; icon: typeof Eye }>> = {
  vision: { label: 'Vision', icon: Eye },
  reasoning: { label: 'Reasoning', icon: Brain },
  tool_calling: { label: 'Tools', icon: Wrench },
  fast: { label: 'Fast', icon: Zap },
  pdf_comprehension: { label: 'PDF', icon: FileText },
  image_generation: { label: 'Images', icon: Image },
};

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  instant: 'Instant',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/**
 * Where new conversations start (v0.10): a model and a reasoning level saved
 * with the account, so every device starts from the same place. Only models
 * and levels the person's role may use are offered; the server checks again.
 * A saved default that is no longer allowed is ignored, and said so here.
 */
function DefaultsForm({ models }: { models: CatalogModel[] }) {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const savedModel = me?.preferences.defaultModelSlug ?? null;
  const savedEffort = me?.preferences.defaultEffort ?? null;
  const problems = me?.chat?.defaultProblems ?? [];
  // A saved default that no longer applies shows as the instance default, so
  // saving clears it.
  const shownModel = models.some((entry) => entry.slug === savedModel) ? (savedModel ?? '') : '';
  const shownEffort = problems.includes('effort') ? '' : (savedEffort ?? '');
  const [model, setModel] = useState(shownModel);
  const [effort, setEffort] = useState<string>(shownEffort);
  const [saved, setSaved] = useState(false);

  useEffect(() => setModel(shownModel), [shownModel]);
  useEffect(() => setEffort(shownEffort), [shownEffort]);

  const instanceModel = models.find((entry) => entry.isDefault) ?? models[0] ?? null;
  const target = models.find((entry) => entry.slug === model) ?? instanceModel;
  const levels = target ? effectiveSupportedEfforts(target) : [];
  const instanceEffort = me?.chat?.instanceDefaultEffort ?? me?.chat?.defaultEffort ?? 'instant';
  const changed = (model || null) !== savedModel || (effort || null) !== savedEffort;

  const save = useMutation({
    mutationFn: () =>
      api.patch('/me/preferences', {
        defaultModelSlug: model || null,
        defaultEffort: effort || null,
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function chooseModel(next: string) {
    save.reset();
    setSaved(false);
    setModel(next);
    // A level the new model does not offer would be refused; start from the default.
    const nextTarget = models.find((entry) => entry.slug === next) ?? instanceModel;
    const offered = nextTarget ? effectiveSupportedEfforts(nextTarget) : [];
    if (effort && !offered.includes(effort as ReasoningEffort)) setEffort('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (changed) save.mutate();
  }

  return (
    <section aria-labelledby="model-defaults-heading" className="mt-8">
      <h2 id="model-defaults-heading" className="text-xl font-bold">
        Defaults
      </h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Where new conversations start, on every device you use. A model or level you pick in a
        conversation applies to that conversation only.
      </p>

      {problems.length > 0 && (
        <div
          role="note"
          className="mt-4 flex flex-col gap-1 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm"
        >
          {problems.includes('model') && (
            <p>
              Your default model is no longer available to you, so new conversations start with the
              instance default. Choose another below.
            </p>
          )}
          {problems.includes('effort') && savedEffort && (
            <p>
              Your default reasoning level, {EFFORT_LABELS[savedEffort]}, is no longer available
              {problems.includes('model') ? '' : ' with your default model'}, so the instance
              default ({EFFORT_LABELS[instanceEffort]}) applies.
            </p>
          )}
        </div>
      )}

      <form onSubmit={submit} noValidate className="mt-4 flex max-w-md flex-col gap-4">
        <Field label="Default model" htmlFor="default-model">
          <Select
            id="default-model"
            value={model}
            onChange={chooseModel}
            options={[
              {
                value: '',
                label: instanceModel
                  ? `Instance default (${instanceModel.displayName})`
                  : 'Instance default',
              },
              ...models.map((entry) => ({ value: entry.slug, label: entry.displayName })),
            ]}
          />
        </Field>
        <Field
          label="Default reasoning level"
          htmlFor="default-effort"
          hint={
            levels.length === 0
              ? `${target?.displayName ?? 'This model'} has no reasoning levels.`
              : 'Used on models that offer it; otherwise the nearest level the model has.'
          }
        >
          <Select
            id="default-effort"
            value={levels.length === 0 ? '' : effort}
            disabled={levels.length === 0}
            onChange={(next) => {
              save.reset();
              setSaved(false);
              setEffort(next);
            }}
            options={[
              { value: '', label: `Instance default (${EFFORT_LABELS[instanceEffort]})` },
              ...levels.map((level) => ({ value: level, label: EFFORT_LABELS[level] })),
            ]}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="accent" size="sm" disabled={!changed || save.isPending}>
            {save.isPending && <Spinner />}
            Save defaults
          </Button>
          {saved && !changed && (
            <span role="status" className="flex items-center gap-1.5 text-sm text-[var(--success)]">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
        </div>
        {save.error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {apiErrorMessage(save.error, 'Your defaults could not be saved. Try again.')}
          </p>
        )}
      </form>
    </section>
  );
}

export function SettingsModelsPage() {
  const { data: models, isLoading } = useModels();
  const { data: me } = useCurrentUser();
  const personalDefault = me?.chat?.defaultModelSlug ?? null;
  const [filter, setFilter] = useState('');

  const term = filter.trim().toLowerCase();
  const visible = (models ?? []).filter(
    (model) =>
      !term ||
      model.displayName.toLowerCase().includes(term) ||
      model.providerLabel.toLowerCase().includes(term),
  );

  return (
    <div>
      <h1 className="text-2xl font-bold">Models</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Where your conversations start, and the models an administrator has made available to your
        role.
      </p>

      {models && models.length > 0 && <DefaultsForm models={models} />}

      <h2 className="mt-12 text-xl font-bold">Available models</h2>
      <div className="mt-4 max-w-sm">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search models..."
          aria-label="Search models"
        />
      </div>

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : visible.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {models?.length === 0
            ? 'No models are available to you yet. Ask an administrator to enable one.'
            : 'No models matched your search.'}
        </p>
      ) : (
        <div className="mt-6 flex flex-col">
          {visible.map((model) => (
            // On a phone the capabilities go under the description, so the
            // name and description have the row's width; beside them they
            // were left about 130 px (#243).
            <div
              key={model.id}
              className="flex flex-col gap-2 border-b border-[var(--border-subtle)] py-4 last:border-0 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-medium text-[var(--text-primary)]">{model.displayName}</p>
                  {model.isDefault && (
                    <Badge variant="accent" className="whitespace-nowrap">
                      instance default
                    </Badge>
                  )}
                  {model.slug === personalDefault && (
                    <Badge variant="success" className="whitespace-nowrap">
                      your default
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {model.providerLabel}
                  {model.contextWindow
                    ? ` · ${(model.contextWindow / 1000).toFixed(0)}k context`
                    : ''}
                </p>
                {model.description && (
                  <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{model.description}</p>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5 sm:shrink-0 sm:justify-end">
                {model.capabilities.map((capability) => {
                  const meta = CAPABILITY_META[capability];
                  if (!meta) return null;
                  return (
                    <span
                      key={capability}
                      className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[0.6875rem] text-[var(--text-secondary)]"
                    >
                      <meta.icon className="size-3" />
                      {meta.label}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

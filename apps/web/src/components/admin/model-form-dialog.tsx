import {
  type AdminModel,
  DEFAULT_MODEL_ROLES,
  DEFAULT_OUTPUT_TOKENS,
  FALLBACK_CONTEXT_WINDOW,
  MICROS_PER_DOLLAR,
  MODEL_CAPABILITIES,
  MODEL_LABS,
  type ModelCapability,
  modelLimitsProblem,
  type Provider,
  REASONING_EFFORTS,
  type ReasoningEffort,
  USER_ROLES,
  type UserRole,
  upsertModelSchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { LabLogo } from '~/components/model/lab-logo';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api, apiErrorMessage } from '~/lib/api-client';
import { cn } from '~/lib/utils';

interface ModelDraft {
  providerId: string;
  labId: string;
  upstreamModelId: string;
  slug: string;
  displayName: string;
  description: string;
  contextWindow: string;
  maxOutputTokens: string;
  sortOrder: string;
  /** Dollars per million tokens, converted to micro-dollars on submit. */
  inputPrice: string;
  outputPrice: string;
  capabilities: ModelCapability[];
  supportedEfforts: ReasoningEffort[];
  visibleToRoles: UserRole[];
  enabled: boolean;
  isDefault: boolean;
}

/** Prices are stored as micro-dollars per million tokens but edited in dollars. */
function toPriceInput(micros: number | null): string {
  return micros === null ? '' : (micros / MICROS_PER_DOLLAR).toString();
}

function toPriceMicros(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed * MICROS_PER_DOLLAR) : null;
}

/**
 * A token count typed in the form: blank is unknown (null), thousands
 * separators are allowed, anything else that is not a whole number is NaN so
 * validation reports it.
 */
export function parseTokenCount(value: string): number | null {
  const digits = value.replace(/[\s,_]/g, '');
  if (!digits) return null;
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

const formatTokens = (value: number) => value.toLocaleString('en-US');

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function initialDraft(model: AdminModel | null, providers: Provider[]): ModelDraft {
  return model
    ? {
        providerId: model.providerId,
        labId: model.labId ?? '',
        upstreamModelId: model.upstreamModelId,
        slug: model.slug,
        displayName: model.displayName,
        description: model.description ?? '',
        contextWindow: model.contextWindow?.toString() ?? '',
        maxOutputTokens: model.maxOutputTokens?.toString() ?? '',
        sortOrder: model.sortOrder.toString(),
        inputPrice: toPriceInput(model.inputPriceMicros),
        outputPrice: toPriceInput(model.outputPriceMicros),
        capabilities: model.capabilities,
        supportedEfforts: model.supportedEfforts,
        visibleToRoles: model.visibleToRoles,
        enabled: model.enabled,
        isDefault: model.isDefault,
      }
    : {
        providerId: providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id ?? '',
        labId: '',
        upstreamModelId: '',
        slug: '',
        displayName: '',
        description: '',
        contextWindow: '',
        maxOutputTokens: '',
        sortOrder: '0',
        inputPrice: '',
        outputPrice: '',
        capabilities: [],
        supportedEfforts: [],
        // As the API and Discover models: not auditors, who review, not chat.
        visibleToRoles: [...DEFAULT_MODEL_ROLES],
        enabled: true,
        isDefault: false,
      };
}

function toggleValue<Value extends string>(values: Value[], value: Value): Value[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function ChoicePills<Value extends string>({
  values,
  options,
  onChange,
}: {
  values: Value[];
  options: readonly Value[];
  onChange: (values: Value[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = values.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(toggleValue(values, option))}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors',
              selected
                ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {option.replaceAll('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}

/** The form's labels, for naming a field in a validation message. */
const FIELD_LABELS: Record<string, string> = {
  providerId: 'Provider',
  labId: 'Lab',
  upstreamModelId: 'Upstream model ID',
  displayName: 'Display name',
  slug: 'OCI slug',
  description: 'Description',
  contextWindow: 'Context window',
  maxOutputTokens: 'Max output',
  sortOrder: 'Sort order',
  inputPriceMicros: 'Input price',
  outputPriceMicros: 'Output price',
  capabilities: 'Capabilities',
  supportedEfforts: 'Reasoning efforts',
  visibleToRoles: 'Visible to roles',
};

/** One sentence per invalid field, in form order. */
export function modelFieldProblems(
  issues: ReadonlyArray<{
    path: PropertyKey[];
    message: string;
    code: string;
    origin?: string;
    maximum?: unknown;
  }>,
): string[] {
  const order = Object.keys(FIELD_LABELS);
  const byField = new Map<string, string>();
  for (const issue of issues) {
    const key = String(issue.path[0] ?? '');
    if (byField.has(key)) continue;
    const label = FIELD_LABELS[key];
    // The schema's own sentences already name the field.
    const text = issue.origin === 'string' && label;
    const sentence =
      text && issue.code === 'too_small'
        ? `${label} is required.`
        : text && issue.code === 'too_big'
          ? `${label} must be at most ${Number(issue.maximum).toLocaleString('en-US')} characters.`
          : label && !issue.message.startsWith(label.replace('OCI ', ''))
            ? `${label}: ${issue.message}`
            : issue.message;
    byField.set(key, sentence);
  }
  return [...byField.entries()]
    .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(([, sentence]) => sentence);
}

export function ModelFormDialog({
  model,
  providers,
  onClose,
}: {
  model: AdminModel | null;
  providers: Provider[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => initialDraft(model, providers));
  const [slugTouched, setSlugTouched] = useState(Boolean(model));
  const [error, setError] = useState<string | null>(null);

  // Whether thinking can be surfaced at all depends on the wire protocol, so
  // the guidance follows whichever provider is selected.
  const selectedProviderKind = providers.find((provider) => provider.id === draft.providerId)?.kind;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      model ? api.patch(`/admin/models/${model.id}`, body) : api.post('/admin/models', body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'providers'] }),
        queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
        queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
      ]);
      onClose();
    },
    onError: (cause) => setError(apiErrorMessage(cause, 'The model could not be saved.')),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    // Every problem at once, named by the form's own labels, rather than one
    // per attempt (#79).
    const problems: string[] = [];
    const contextWindow = parseTokenCount(draft.contextWindow);
    const maxOutputTokens = parseTokenCount(draft.maxOutputTokens);
    if (Number.isNaN(contextWindow)) {
      problems.push('Context window must be a whole number of tokens.');
    }
    if (Number.isNaN(maxOutputTokens)) {
      problems.push('Max output must be a whole number of tokens.');
    }
    const parsed = upsertModelSchema.safeParse({
      ...draft,
      labId: draft.labId || null,
      description: draft.description.trim() || null,
      contextWindow: Number.isNaN(contextWindow) ? null : contextWindow,
      maxOutputTokens: Number.isNaN(maxOutputTokens) ? null : maxOutputTokens,
      sortOrder: Number(draft.sortOrder || 0),
      inputPriceMicros: toPriceMicros(draft.inputPrice),
      outputPriceMicros: toPriceMicros(draft.outputPrice),
    });
    if (!parsed.success) problems.push(...modelFieldProblems(parsed.error.issues));
    const limits =
      problems.length === 0 ? modelLimitsProblem(contextWindow, maxOutputTokens) : null;
    if (limits) problems.push(limits);
    if (!parsed.success || problems.length > 0) {
      setError(problems.length > 0 ? problems.join('\n') : 'Check the model fields.');
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{model ? 'Edit model' : 'Add model'}</DialogTitle>
        <DialogDescription>
          Map an upstream model from a configured provider into OCI’s curated catalog.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider" htmlFor="model-provider">
            <Select
              id="model-provider"
              value={draft.providerId}
              onChange={(providerId) => setDraft((current) => ({ ...current, providerId }))}
              options={providers.map((provider) => ({
                value: provider.id,
                label: `${provider.label}${provider.enabled ? '' : ' (disabled)'}`,
              }))}
            />
          </Field>

          <Field
            label="Lab"
            htmlFor="model-lab"
            hint="Who created the model. Supplies the logo shown next to it."
          >
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]">
                <LabLogo labId={draft.labId} className="size-5" />
              </span>
              <Select
                id="model-lab"
                className="min-w-0 flex-1"
                value={draft.labId}
                onChange={(labId) => setDraft((current) => ({ ...current, labId }))}
                options={[
                  { value: '', label: 'No lab' },
                  ...MODEL_LABS.map((lab) => ({ value: lab.id, label: lab.name })),
                ]}
              />
            </div>
          </Field>

          <Field label="Upstream model ID" htmlFor="upstream-model-id">
            <Input
              id="upstream-model-id"
              value={draft.upstreamModelId}
              placeholder="gpt-4o-mini"
              onChange={(event) => {
                const upstreamModelId = event.target.value;
                setDraft((current) => ({
                  ...current,
                  upstreamModelId,
                  ...(!slugTouched ? { slug: slugify(upstreamModelId) } : {}),
                }));
              }}
            />
          </Field>

          <Field label="Display name" htmlFor="model-display-name">
            <Input
              id="model-display-name"
              value={draft.displayName}
              placeholder="GPT-4o Mini"
              onChange={(event) =>
                setDraft((current) => ({ ...current, displayName: event.target.value }))
              }
            />
          </Field>

          <Field
            label="OCI slug"
            htmlFor="model-slug"
            hint="Lowercase letters, numbers, and dashes."
          >
            <Input
              id="model-slug"
              value={draft.slug}
              placeholder="gpt-4o-mini"
              onChange={(event) => {
                setSlugTouched(true);
                setDraft((current) => ({ ...current, slug: event.target.value }));
              }}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="model-description">
          <Textarea
            id="model-description"
            rows={3}
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
          />
        </Field>

        {/*
         * Provider discovery does not report these, so without them OCI budgets
         * every model as if it had the fallback window and output, which cuts
         * long conversations short on large models.
         */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Context window"
            htmlFor="model-context-window"
            hint={`Tokens the model accepts, input and output together. Leave blank if unknown: OCI then assumes ${formatTokens(FALLBACK_CONTEXT_WINDOW)}.`}
          >
            <Input
              id="model-context-window"
              inputMode="numeric"
              autoComplete="off"
              placeholder={formatTokens(FALLBACK_CONTEXT_WINDOW)}
              value={draft.contextWindow}
              onChange={(event) =>
                setDraft((current) => ({ ...current, contextWindow: event.target.value }))
              }
            />
          </Field>
          <Field
            label="Max output"
            htmlFor="model-max-output"
            hint={`Most tokens the model writes in one reply. Leave blank if unknown: OCI then reserves ${formatTokens(DEFAULT_OUTPUT_TOKENS)}, or a quarter of the context window if that is smaller.`}
          >
            <Input
              id="model-max-output"
              inputMode="numeric"
              autoComplete="off"
              placeholder={formatTokens(DEFAULT_OUTPUT_TOKENS)}
              value={draft.maxOutputTokens}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxOutputTokens: event.target.value }))
              }
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sort order" htmlFor="model-sort-order">
            <Input
              id="model-sort-order"
              type="number"
              value={draft.sortOrder}
              onChange={(event) =>
                setDraft((current) => ({ ...current, sortOrder: event.target.value }))
              }
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Input price"
            htmlFor="model-input-price"
            hint="US dollars per million input tokens. Leave blank if unpriced."
          >
            <Input
              id="model-input-price"
              type="number"
              min={0}
              step="0.01"
              placeholder="3.00"
              value={draft.inputPrice}
              onChange={(event) =>
                setDraft((current) => ({ ...current, inputPrice: event.target.value }))
              }
            />
          </Field>
          <Field
            label="Output price"
            htmlFor="model-output-price"
            hint="US dollars per million output tokens."
          >
            <Input
              id="model-output-price"
              type="number"
              min={0}
              step="0.01"
              placeholder="15.00"
              value={draft.outputPrice}
              onChange={(event) =>
                setDraft((current) => ({ ...current, outputPrice: event.target.value }))
              }
            />
          </Field>
        </div>

        <Field label="Capabilities">
          <ChoicePills
            values={draft.capabilities}
            options={MODEL_CAPABILITIES}
            onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))}
          />
        </Field>
        <Field label="Reasoning efforts">
          <ChoicePills
            values={draft.supportedEfforts}
            options={REASONING_EFFORTS}
            onChange={(supportedEfforts) =>
              setDraft((current) => ({ ...current, supportedEfforts }))
            }
          />
          {draft.supportedEfforts.length > 0 && (
            <p className="mt-2 text-[var(--text-muted)] text-xs leading-relaxed">
              {selectedProviderKind === 'openai-compatible'
                ? 'Effort is applied, but whether any thinking is shown depends on the model. Some report it and some return only the answer. If a model should show its thinking and does not, a provider using the Responses API may.'
                : 'Effort is applied and a summary of the thinking is shown while the model works, when the model produces one.'}
            </p>
          )}
        </Field>
        <Field label="Visible to roles">
          <ChoicePills
            values={draft.visibleToRoles}
            options={USER_ROLES}
            onChange={(visibleToRoles) => setDraft((current) => ({ ...current, visibleToRoles }))}
          />
        </Field>

        <div className="grid gap-3 rounded-xl border border-[var(--border-subtle)] p-4 sm:grid-cols-2">
          <label
            htmlFor="model-enabled"
            className="flex items-center justify-between gap-3 text-sm"
          >
            Enabled in catalog
            <Switch
              id="model-enabled"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </label>
        </div>

        {error && (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-sm text-[var(--danger-on-tint)]"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={save.isPending || providers.length === 0}
          >
            {save.isPending && <Spinner />}
            {model ? 'Save model' : 'Add model'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

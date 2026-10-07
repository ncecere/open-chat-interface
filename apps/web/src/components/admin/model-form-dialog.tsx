import {
  type AdminModel,
  DEFAULT_OUTPUT_TOKENS,
  FALLBACK_CONTEXT_WINDOW,
  MODEL_CAPABILITIES,
  MODEL_LABS,
  modelLimitsProblem,
  type Provider,
  REASONING_EFFORTS,
  USER_ROLES,
  upsertModelSchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useEditedSince } from '~/components/admin/unsaved-changes';
import { CAPABILITY_LABELS } from '~/components/chat/model-picker-data';
import { LabLogo } from '~/components/model/lab-logo';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api, apiErrorProblems } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import {
  draftField,
  formatTokens,
  initialDraft,
  modelFieldProblems,
  parseTokenCount,
  slugify,
  toPriceMicros,
} from './model-form-draft';

export { modelFieldProblems, parseTokenCount } from './model-form-draft';

function toggleValue<Value extends string>(values: Value[], value: Value): Value[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function ChoicePills<Value extends string>({
  values,
  options,
  onChange,
  labels,
}: {
  values: Value[];
  options: readonly Value[];
  onChange: (values: Value[]) => void;
  /** Names to show; otherwise the value, spaced and capitalised. */
  labels?: Readonly<Record<Value, string>>;
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
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              !labels && 'capitalize',
              selected
                ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            {labels?.[option] ?? option.replaceAll('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}

/** The form fields that show their own errors; any other is shown at the foot (#302). */
const FIELDS_SHOWN = [
  'upstreamModelId',
  'displayName',
  'slug',
  'description',
  'contextWindow',
  'maxOutputTokens',
  'sortOrder',
  'inputPrice',
  'outputPrice',
];

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
  // The listed problems were about the form as it was submitted; each goes
  // once its own field changes (#178), and the rest stay until fixed (#257).
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems(draft, form);
  const edited = useEditedSince(draft); // Escape asks before discarding (#300).
  // Each problem under its field, marked invalid and described by it (#302).
  const at = (field: string) => problemsAt(problems, field);
  const error = problemsElsewhere(problems, FIELDS_SHOWN);

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
    onError: (cause) =>
      setProblems(
        apiErrorProblems(cause, 'The model could not be saved.').map((problem) => ({
          ...problem,
          fields: problem.fields.map(draftField),
        })),
      ),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);

    // Every problem at once, named by the form's own labels, rather than one
    // per attempt (#79).
    const problems: FieldProblem[] = [];
    const contextWindow = parseTokenCount(draft.contextWindow);
    const maxOutputTokens = parseTokenCount(draft.maxOutputTokens);
    if (Number.isNaN(contextWindow)) {
      problems.push({
        fields: ['contextWindow'],
        text: 'Context window must be a whole number of tokens.',
      });
    }
    if (Number.isNaN(maxOutputTokens)) {
      problems.push({
        fields: ['maxOutputTokens'],
        text: 'Max output must be a whole number of tokens.',
      });
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
    // The room-for-input rule is checked alongside the others, not only once
    // they pass, so a bad slug and a too-large output are listed together
    // (#129). It is skipped only when either limit is itself invalid.
    const limitFieldInvalid =
      Number.isNaN(contextWindow) ||
      Number.isNaN(maxOutputTokens) ||
      (!parsed.success &&
        parsed.error.issues.some((issue) =>
          ['contextWindow', 'maxOutputTokens'].includes(String(issue.path[0])),
        ));
    const limits = limitFieldInvalid ? null : modelLimitsProblem(contextWindow, maxOutputTokens);
    // Either limit can answer this one.
    if (limits) problems.push({ fields: ['contextWindow', 'maxOutputTokens'], text: limits });
    if (!parsed.success || problems.length > 0) {
      setProblems(
        problems.length > 0 ? problems : [{ fields: [], text: 'Check the model fields.' }],
      );
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{model ? 'Edit model' : 'Add model'}</DialogTitle>
        <DialogDescription>
          Map an upstream model from a configured provider into OCI’s curated catalog.
        </DialogDescription>
      </DialogHeader>

      <form ref={form} onSubmit={submit} className="flex flex-col gap-5">
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

          <Field
            label="Upstream model ID"
            htmlFor="upstream-model-id"
            error={at('upstreamModelId')}
          >
            <Input
              id="upstream-model-id"
              {...invalidFieldProps('upstream-model-id', at('upstreamModelId'))}
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

          <Field label="Display name" htmlFor="model-display-name" error={at('displayName')}>
            <Input
              id="model-display-name"
              {...invalidFieldProps('model-display-name', at('displayName'))}
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
            error={at('slug')}
            hint="Lowercase letters, numbers, and dashes."
          >
            <Input
              id="model-slug"
              {...invalidFieldProps('model-slug', at('slug'))}
              value={draft.slug}
              placeholder="gpt-4o-mini"
              onChange={(event) => {
                setSlugTouched(true);
                setDraft((current) => ({ ...current, slug: event.target.value }));
              }}
            />
          </Field>
        </div>

        <Field label="Description" htmlFor="model-description" error={at('description')}>
          <Textarea
            id="model-description"
            {...invalidFieldProps('model-description', at('description'))}
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
            error={at('contextWindow')}
            hint={`Tokens the model accepts, input and output together. Leave blank if unknown: OCI then assumes ${formatTokens(FALLBACK_CONTEXT_WINDOW)}.`}
          >
            <Input
              id="model-context-window"
              {...invalidFieldProps('model-context-window', at('contextWindow'))}
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
            error={at('maxOutputTokens')}
            hint={`Most tokens the model writes in one reply. Leave blank if unknown: OCI then reserves ${formatTokens(DEFAULT_OUTPUT_TOKENS)}, or a quarter of the context window if that is smaller.`}
          >
            <Input
              id="model-max-output"
              {...invalidFieldProps('model-max-output', at('maxOutputTokens'))}
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
          <Field label="Sort order" htmlFor="model-sort-order" error={at('sortOrder')}>
            <Input
              id="model-sort-order"
              {...invalidFieldProps('model-sort-order', at('sortOrder'))}
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
            error={at('inputPrice')}
            hint="US dollars per million input tokens. Leave blank if unpriced."
          >
            <Input
              id="model-input-price"
              {...invalidFieldProps('model-input-price', at('inputPrice'))}
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
            error={at('outputPrice')}
            hint="US dollars per million output tokens."
          >
            <Input
              id="model-output-price"
              {...invalidFieldProps('model-output-price', at('outputPrice'))}
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
            // The names the model list and picker use: "PDF comprehension",
            // not "Pdf Comprehension" here and "PDF" there (#228).
            labels={CAPABILITY_LABELS}
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

        {/* Full width, so the switch sits at the right as in every other dialog (#228). */}
        <div className="rounded-xl border border-[var(--border-subtle)] p-4">
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

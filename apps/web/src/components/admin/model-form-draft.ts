import {
  type AdminModel,
  DEFAULT_MODEL_ROLES,
  MICROS_PER_DOLLAR,
  type ModelCapability,
  type Provider,
  type ReasoningEffort,
  type UserRole,
} from '@oci/shared';
import type { FieldProblem } from '~/hooks/use-clear-on-edit';

/**
 * The Add/Edit model form's draft and its validation sentences, apart from
 * the dialog so it stays under the file-size rule (#302).
 */

export interface ModelDraft {
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

export function toPriceMicros(value: string): number | null {
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

export const formatTokens = (value: number) => value.toLocaleString('en-US');

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function initialDraft(model: AdminModel | null, providers: Provider[]): ModelDraft {
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

/** The form field a schema key is edited in, where the two differ. */
const DRAFT_FIELDS: Record<string, keyof ModelDraft> = {
  inputPriceMicros: 'inputPrice',
  outputPriceMicros: 'outputPrice',
};
export const draftField = (key: string) => DRAFT_FIELDS[key] ?? key;

/** One sentence per invalid field, in form order, with the form field it is about. */
export function modelFieldProblems(
  issues: ReadonlyArray<{
    path: PropertyKey[];
    message: string;
    code: string;
    origin?: string;
    maximum?: unknown;
  }>,
): FieldProblem[] {
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
    .map(([key, text]) => ({ fields: [draftField(key)], text }));
}

import {
  MICROS_PER_DOLLAR,
  type QuotaMetric,
  type QuotaWindowKind,
  TOKENS_PER_PRICE_UNIT,
  type UsageAllowance,
} from '@oci/shared';

export interface EvaluablePolicy {
  id: string;
  name: string;
  metric: QuotaMetric;
  limitValue: number;
  windowKind: QuotaWindowKind;
  windowHours: number | null;
  timezone: string;
}

export interface WindowTotals {
  messages: number;
  tokens: number;
  costMicros: number;
}

export interface ModelPricing {
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
}

/**
 * Cost in micro-dollars for one generation. Prices are per million tokens, so
 * the division happens once at the end and rounds up: partial usage is never
 * free, which keeps a budget from being overspent by rounding.
 */
export function calculateCostMicros(
  pricing: ModelPricing,
  tokensIn: number,
  tokensOut: number,
): number {
  const input = (pricing.inputPriceMicros ?? 0) * Math.max(0, tokensIn);
  const output = (pricing.outputPriceMicros ?? 0) * Math.max(0, tokensOut);
  const total = input + output;
  return total === 0 ? 0 : Math.ceil(total / TOKENS_PER_PRICE_UNIT);
}

export function usedForMetric(metric: QuotaMetric, totals: WindowTotals): number {
  switch (metric) {
    case 'messages':
      return totals.messages;
    case 'tokens':
      return totals.tokens;
    case 'cost':
      return totals.costMicros;
    default:
      return 0;
  }
}

export function formatMicros(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  // Sub-cent amounts would otherwise all render as "$0.00".
  const precision = micros > 0 && dollars < 0.01 ? 4 : 2;
  return `$${dollars.toFixed(precision)}`;
}

/** Human-readable window description used in limit messages. */
export function describeWindow(policy: EvaluablePolicy): string {
  switch (policy.windowKind) {
    case 'rolling':
      return `the last ${policy.windowHours ?? 24} hours`;
    case 'daily':
      return 'today';
    case 'weekly':
      return 'this week';
    case 'monthly':
      return 'this month';
    default:
      return 'this window';
  }
}

export function describeLimit(policy: EvaluablePolicy): string {
  switch (policy.metric) {
    case 'messages':
      return `${policy.limitValue.toLocaleString()} messages`;
    case 'tokens':
      return `${policy.limitValue.toLocaleString()} tokens`;
    case 'cost':
      return formatMicros(policy.limitValue);
    default:
      return String(policy.limitValue);
  }
}

export function buildAllowance(
  policy: EvaluablePolicy,
  totals: WindowTotals,
  resetsAt: Date | null,
): UsageAllowance {
  const used = usedForMetric(policy.metric, totals);
  return {
    policyId: policy.id,
    name: policy.name,
    metric: policy.metric,
    windowKind: policy.windowKind,
    windowHours: policy.windowHours,
    used,
    limitValue: policy.limitValue,
    remaining: Math.max(0, policy.limitValue - used),
    exceeded: used >= policy.limitValue,
    resetsAt: resetsAt?.toISOString() ?? null,
  };
}

export function limitMessage(policy: EvaluablePolicy): string {
  return `You have reached the ${policy.name} limit of ${describeLimit(policy)} for ${describeWindow(policy)}.`;
}

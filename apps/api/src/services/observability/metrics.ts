import { APP_VERSION } from '../../version.js';

/**
 * A minimal Prometheus registry and text exposition (format 0.0.4).
 *
 * Hand-written rather than a dependency: OCI needs counters, histograms and a
 * few gauges read at scrape time, and nothing else. Values are per process,
 * so each API replica is scraped on its own.
 *
 * Labels never carry user content or identifiers: routes are templates
 * (`/api/threads/:id`), tools are administrator-configured ids, and every
 * other label is a fixed vocabulary. Values are also length-capped.
 */

type Labels = Record<string, string>;

const MAX_LABEL_LENGTH = 120;

function escapeLabel(value: string): string {
  return value
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((name, index) => `${name}="${escapeLabel(values[index] ?? '')}"`);
  if (extra) parts.push(extra);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

interface Metric {
  readonly name: string;
  render(): string | Promise<string>;
}

abstract class LabelledMetric<T> implements Metric {
  protected readonly series = new Map<string, { values: string[]; state: T }>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  protected entry(labels: Labels, create: () => T): T {
    const values = this.labelNames.map((name) => String(labels[name] ?? ''));
    const key = values.join('\u0000');
    let found = this.series.get(key);
    if (!found) {
      found = { values, state: create() };
      this.series.set(key, found);
    }
    return found.state;
  }

  abstract render(): string;

  /** Test helper: forget every series. */
  reset(): void {
    this.series.clear();
  }
}

export class Counter extends LabelledMetric<{ value: number }> {
  inc(labels: Labels = {}, amount = 1): void {
    if (!(amount >= 0)) return;
    this.entry(labels, () => ({ value: 0 })).value += amount;
  }

  /** Current value for a label set, for tests. */
  get(labels: Labels = {}): number {
    const key = this.labelNames.map((name) => String(labels[name] ?? '')).join('\u0000');
    return this.series.get(key)?.state.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { values, state } of this.series.values())
      lines.push(
        `${this.name}${formatLabels(this.labelNames, values)} ${formatNumber(state.value)}`,
      );
    return lines.join('\n');
  }
}

export class Histogram extends LabelledMetric<{ buckets: number[]; sum: number; count: number }> {
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly bounds: readonly number[],
  ) {
    super(name, help, labelNames);
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const state = this.entry(labels, () => ({
      buckets: this.bounds.map(() => 0),
      sum: 0,
      count: 0,
    }));
    for (let index = 0; index < this.bounds.length; index++)
      if (value <= this.bounds[index]!) state.buckets[index]! += 1;
    state.sum += value;
    state.count += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { values, state } of this.series.values()) {
      this.bounds.forEach((bound, index) => {
        lines.push(
          `${this.name}_bucket${formatLabels(this.labelNames, values, `le="${formatNumber(bound)}"`)} ${state.buckets[index]}`,
        );
      });
      lines.push(
        `${this.name}_bucket${formatLabels(this.labelNames, values, 'le="+Inf"')} ${state.count}`,
      );
      lines.push(
        `${this.name}_sum${formatLabels(this.labelNames, values)} ${formatNumber(state.sum)}`,
      );
      lines.push(`${this.name}_count${formatLabels(this.labelNames, values)} ${state.count}`);
    }
    return lines.join('\n');
  }
}

/** A gauge whose samples are read when scraped; a failing reader contributes no samples. */
export class CollectedGauge implements Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    private readonly collect: () => Promise<Array<{ labels?: Labels; value: number }>>,
  ) {}

  async render(): Promise<string> {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    try {
      for (const sample of await this.collect()) {
        const values = this.labelNames.map((name) => String(sample.labels?.[name] ?? ''));
        lines.push(
          `${this.name}${formatLabels(this.labelNames, values)} ${formatNumber(sample.value)}`,
        );
      }
    } catch {
      // A scrape must not fail because one source (such as the database) is down.
    }
    return lines.join('\n');
  }
}

const registry: Metric[] = [];

function register<T extends Metric>(metric: T): T {
  registry.push(metric);
  return metric;
}

/** Seconds; covers fast API calls through long model replies. */
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];
const LONG_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200];

export const httpRequests = register(
  new Counter('oci_http_requests_total', 'HTTP requests by method, route template and status.', [
    'method',
    'route',
    'status',
  ]),
);
export const httpRequestDuration = register(
  new Histogram(
    'oci_http_request_duration_seconds',
    'HTTP request duration until the response starts, by method and route template.',
    ['method', 'route'],
    DURATION_BUCKETS,
  ),
);
export const chatReplies = register(
  new Counter('oci_chat_replies_total', 'Chat replies by final status.', ['status']),
);
export const chatReplyDuration = register(
  new Histogram(
    'oci_chat_reply_duration_seconds',
    'Chat reply duration from start to the end of generation, by final status.',
    ['status'],
    DURATION_BUCKETS,
  ),
);
export const toolCalls = register(
  new Counter('oci_tool_calls_total', 'Tool calls by tool id and outcome.', ['tool', 'outcome']),
);
export const toolCallDuration = register(
  new Histogram(
    'oci_tool_call_duration_seconds',
    'Tool call duration by tool id.',
    ['tool'],
    DURATION_BUCKETS,
  ),
);
export const jobRuns = register(
  new Counter('oci_job_runs_total', 'Background job runs by job and outcome.', ['job', 'outcome']),
);
export const jobDuration = register(
  new Histogram(
    'oci_job_duration_seconds',
    'Background job duration by job.',
    ['job'],
    DURATION_BUCKETS,
  ),
);
export const webSearches = register(
  new Counter(
    'oci_web_searches_total',
    'Web searches from conversations by provider, slot (primary, fallback) and outcome (answered, failed). Never the query.',
    ['provider', 'slot', 'outcome'],
  ),
);
export const webSearchDuration = register(
  new Histogram(
    'oci_web_search_duration_seconds',
    'Web search duration per provider and slot, retry included.',
    ['provider', 'slot'],
    DURATION_BUCKETS,
  ),
);
export const webhookDeliveries = register(
  new Counter(
    'oci_webhook_deliveries_total',
    'Webhook delivery attempts by outcome (succeeded, retrying, failed).',
    ['outcome'],
  ),
);
export const backupRuns = register(
  new Counter('oci_backup_runs_total', 'Automated backup runs by outcome.', ['outcome']),
);
export const backupDuration = register(
  new Histogram('oci_backup_duration_seconds', 'Automated backup duration.', [], LONG_BUCKETS),
);
export const errors = register(
  new Counter('oci_errors_total', 'Unexpected server errors by source.', ['source']),
);

register(
  new CollectedGauge('oci_build_info', 'OCI version of this process.', ['version'], async () => [
    { labels: { version: APP_VERSION }, value: 1 },
  ]),
);
register(
  new CollectedGauge(
    'process_resident_memory_bytes',
    'Resident memory size in bytes.',
    [],
    async () => [{ value: process.memoryUsage.rss() }],
  ),
);
register(
  new CollectedGauge('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.', [], async () => [
    { value: process.memoryUsage().heapUsed },
  ]),
);
register(
  new CollectedGauge(
    'process_uptime_seconds',
    'Seconds since this process started.',
    [],
    async () => [{ value: Math.round(process.uptime()) }],
  ),
);

/** Registers a gauge read at scrape time, such as a queue depth from the database. */
export function registerCollectedGauge(
  name: string,
  help: string,
  labelNames: readonly string[],
  collect: () => Promise<Array<{ labels?: Labels; value: number }>>,
): void {
  if (registry.some((metric) => metric.name === name)) return;
  register(new CollectedGauge(name, help, labelNames, collect));
}

/** The whole registry in Prometheus text format. */
export async function renderMetrics(): Promise<string> {
  const blocks = await Promise.all(registry.map((metric) => metric.render()));
  return `${blocks.join('\n')}\n`;
}

/** Test helper: clears every counter and histogram. */
export function resetMetrics(): void {
  for (const metric of registry) if (metric instanceof LabelledMetric) metric.reset();
}

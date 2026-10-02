import type { Attributes, Context, Span, SpanKind, Tracer } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { APP_VERSION } from '../../version.js';

/**
 * OpenTelemetry traces, exported over OTLP/HTTP when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 *
 * The SDK is loaded with dynamic imports inside `initTracing`, so a process
 * without the variable never loads it: startup and memory are unchanged and
 * every helper here is a cheap no-op.
 *
 * Spans carry route templates, job and tool names, statuses and durations.
 * They never carry prompts, replies, tool inputs or results, file names, or
 * request bodies.
 */

type OtelApi = typeof import('@opentelemetry/api');

interface TracingState {
  api: OtelApi;
  tracer: Tracer;
  shutdown: () => Promise<void>;
}

let state: TracingState | null = null;

export function tracingEnabled(): boolean {
  return state !== null;
}

/** The exporter endpoint's origin, for display; never its path or credentials. */
export function tracingEndpointOrigin(): string | null {
  const endpoint = loadEnv().OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * Starts tracing when an OTLP endpoint is configured. Returns whether it is
 * on. `exporter` replaces the OTLP exporter (tests use an in-memory one).
 */
export async function initTracing(options?: {
  endpoint?: string;
  serviceName?: string;
  exporter?: SpanExporter;
}): Promise<boolean> {
  if (state) return true;
  const env = loadEnv();
  const endpoint = options?.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return false;

  const [api, sdkNode, sdkBase, resources] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
  ]);

  let exporter = options?.exporter;
  if (!exporter) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    // The standard variable names a base URL; the exporter appends /v1/traces
    // only when it reads the variable itself, so do the same here.
    const base = endpoint.replace(/\/+$/, '');
    exporter = new OTLPTraceExporter({
      url: base.endsWith('/v1/traces') ? base : `${base}/v1/traces`,
    });
  }

  const provider = new sdkNode.NodeTracerProvider({
    resource: resources.resourceFromAttributes({
      'service.name': options?.serviceName ?? env.OTEL_SERVICE_NAME,
      'service.version': APP_VERSION,
    }),
    spanProcessors: [
      options?.exporter
        ? new sdkBase.SimpleSpanProcessor(exporter)
        : new sdkBase.BatchSpanProcessor(exporter),
    ],
  });
  // Installs the AsyncLocalStorage context manager and W3C trace-context propagation.
  provider.register();

  state = {
    api,
    tracer: api.trace.getTracer('oci-api', APP_VERSION),
    shutdown: async () => {
      await provider.shutdown();
      api.trace.disable();
      api.context.disable();
      api.propagation.disable();
    },
  };
  logger.info({ endpoint: tracingEndpointOrigin() ?? 'custom' }, 'OpenTelemetry tracing enabled');
  return true;
}

/** Flushes and stops tracing. Safe to call when tracing is off. */
export async function shutdownTracing(): Promise<void> {
  const current = state;
  state = null;
  await current?.shutdown().catch((error: unknown) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Tracing shutdown failed',
    );
  });
}

/** A started span, or a no-op when tracing is off. */
export interface SpanHandle {
  setAttributes(attributes: Attributes): void;
  /** Renames the span, for names known only at the end (an HTTP route template). */
  rename(name: string): void;
  /** Marks the span failed with a short, content-free description. */
  fail(description: string): void;
  end(endTime?: Date | number): void;
}

const NOOP: SpanHandle = { setAttributes() {}, rename() {}, fail() {}, end() {} };

function wrap(span: Span, api: OtelApi): SpanHandle {
  return {
    setAttributes: (attributes) => span.setAttributes(attributes),
    rename: (name) => span.updateName(name),
    fail: (description) =>
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: description.slice(0, 200) }),
    end: (endTime) => span.end(endTime),
  };
}

type Kind = 'server' | 'internal' | 'client';

function spanKind(api: OtelApi, kind: Kind): SpanKind {
  return kind === 'server'
    ? api.SpanKind.SERVER
    : kind === 'client'
      ? api.SpanKind.CLIENT
      : api.SpanKind.INTERNAL;
}

/**
 * Runs `work` inside a span, so spans started within it become its children.
 * The span fails when `work` throws; the error message is not recorded.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: SpanHandle) => Promise<T>,
  options?: { kind?: Kind; parent?: Context },
): Promise<T> {
  const current = state;
  if (!current) return work(NOOP);
  const { api, tracer } = current;
  const parent = options?.parent ?? api.context.active();
  const span = tracer.startSpan(
    name,
    { kind: spanKind(api, options?.kind ?? 'internal'), attributes },
    parent,
  );
  const handle = wrap(span, api);
  try {
    return await api.context.with(api.trace.setSpan(parent, span), () => work(handle));
  } catch (error) {
    handle.fail(error instanceof Error ? error.name : 'error');
    throw error;
  } finally {
    span.end();
  }
}

/** Records a finished operation whose start was measured elsewhere. */
export function recordSpan(
  name: string,
  attributes: Attributes,
  startTime: Date | number,
  options?: { failed?: string; endTime?: Date | number },
): void {
  const current = state;
  if (!current) return;
  const span = current.tracer.startSpan(name, {
    kind: current.api.SpanKind.INTERNAL,
    attributes,
    startTime,
  });
  const handle = wrap(span, current.api);
  if (options?.failed) handle.fail(options.failed);
  handle.end(options?.endTime ?? Date.now());
}

/** Extracts an incoming W3C `traceparent` so a server span joins the caller's trace. */
export function extractTraceContext(headers: Headers): Context | undefined {
  const current = state;
  if (!current) return undefined;
  const carrier: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key === 'traceparent' || key === 'tracestate') carrier[key] = value;
  });
  return current.api.propagation.extract(current.api.context.active(), carrier);
}

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Tracing starts only when an OTLP endpoint is configured, loads the SDK only
 * then, and records route templates, job and tool names, never content.
 */
const flags = vi.hoisted(() => ({ sdkLoaded: false, env: {} as Record<string, unknown> }));
vi.mock('@opentelemetry/sdk-trace-node', async (importOriginal) => {
  flags.sdkLoaded = true;
  return importOriginal();
});
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return { ...actual, loadEnv: () => ({ ...actual.loadEnv(), ...flags.env }) };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('tracing', () => {
  afterEach(async () => {
    const { shutdownTracing } = await import('../../services/observability/tracing.js');
    await shutdownTracing();
    flags.env = {};
  });

  it('stays off, and never loads the SDK, without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
    flags.env = { OTEL_EXPORTER_OTLP_ENDPOINT: undefined };
    const tracing = await import('../../services/observability/tracing.js');
    expect(await tracing.initTracing()).toBe(false);
    expect(tracing.tracingEnabled()).toBe(false);
    expect(tracing.tracingEndpointOrigin()).toBeNull();
    expect(flags.sdkLoaded).toBe(false);
    // Helpers are no-ops that still run the work.
    expect(
      await tracing.withSpan('noop', {}, async (span) => {
        span.setAttributes({ a: 1 });
        span.rename('x');
        span.fail('x');
        span.end();
        return 42;
      }),
    ).toBe(42);
    tracing.recordSpan('noop', {}, Date.now());
    expect(tracing.extractTraceContext(new Headers())).toBeUndefined();
  });

  it('exports spans for requests, jobs, tool calls and replies, without content', async () => {
    flags.env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pw@collector.example.test:4318/base?x=1',
    };
    const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace-base');
    const exporter = new InMemorySpanExporter();
    const tracing = await import('../../services/observability/tracing.js');
    expect(await tracing.initTracing({ exporter })).toBe(true);
    expect(await tracing.initTracing({ exporter })).toBe(true);
    expect(flags.sdkLoaded).toBe(true);
    expect(tracing.tracingEnabled()).toBe(true);
    // Only the origin is ever shown.
    expect(tracing.tracingEndpointOrigin()).toBe('https://collector.example.test:4318');

    const { observeRequests } = await import('../../services/observability/http.js');
    const { observeChatReply, observeToolCall } = await import(
      '../../services/observability/events.js'
    );

    const app = new Hono();
    app.use('*', observeRequests);
    app.post('/api/chat/:threadId', async (c) => {
      // A span started inside a request is its child.
      await tracing.withSpan('inner', {}, async () => undefined);
      return c.json({ ok: true });
    });
    app.get('/api/broken', () => {
      throw new Error('secret detail');
    });
    app.onError((_, c) => c.json({}, 500));
    await app.request('/api/chat/thread-123?q=private', {
      method: 'POST',
      body: 'Tell me a secret prompt',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    await app.request('/api/broken');
    observeToolCall('web_search', 'error', 250);
    observeChatReply('error', Date.now() - 2000);
    await expect(
      tracing.withSpan('job failing', { 'oci.job.name': 'x' }, async () => {
        throw new Error('content of the failure');
      }),
    ).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    const byName = (name: string) => spans.find((span) => span.name === name);
    const request = byName('POST /api/chat/:threadId')!;
    expect(request).toBeDefined();
    expect(request.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/api/chat/:threadId',
      'http.response.status_code': 200,
    });
    // Joined the caller's trace, and the inner span is its child.
    expect(request.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(byName('inner')!.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(byName('GET /api/broken')!.status.code).toBe(2);
    expect(byName('tool.call')!.attributes).toEqual({
      'oci.tool.id': 'web_search',
      'oci.tool.outcome': 'error',
    });
    expect(byName('chat.reply')!.attributes).toEqual({ 'oci.reply.status': 'error' });
    expect(byName('job failing')!.status).toMatchObject({ code: 2, message: 'Error' });

    const everything = JSON.stringify(
      spans.map((span) => [span.name, span.attributes, span.status, span.events]),
    );
    for (const secret of [
      'thread-123',
      'private',
      'secret prompt',
      'secret detail',
      'content of the failure',
    ])
      expect(everything).not.toContain(secret);
  });
});

import { createAnthropic, VERSION } from '@ai-sdk/anthropic';
import type { ReasoningEffort } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { generationSettings } from '../../services/chat/generation-settings.js';

// Capture the installed adapter's final HTTP request; no inference/network calls.
async function requestBody(modelId: string, effort: ReasoningEffort | undefined, total = 4096) {
  let body: Record<string, unknown> | undefined;
  const provider = createAnthropic({
    apiKey: 'fixture',
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const result = await provider(modelId).doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
    ...generationSettings(effort, 'anthropic', modelId, total),
  });
  await result.stream.cancel();
  return body!;
}

describe('Anthropic total output reservation at the adapter boundary', () => {
  it('requires an explicit budget-mapping review when the adapter version changes', () => {
    expect(VERSION).toBe('4.0.33');
  });
  it.each(['low', 'medium', 'high'] as const)(
    'keeps legacy Sonnet %s thinking inside the reserved total',
    async (effort) => {
      const body = await requestBody('claude-sonnet-4-20250514', effort);
      expect(body.max_tokens).toBe(4096);
      expect(body.thinking).toMatchObject({ type: 'enabled' });
    },
  );
  it.each([
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-fable-5',
    'claude-sonnet-5',
    'claude-future-unknown',
  ])('preserves adaptive thinking for %s without expanding output', async (id) => {
    expect(await requestBody(id, 'high')).toMatchObject({
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
  });
  it.each([
    ['claude-sonnet-4-20250514', 64000],
    ['claude-sonnet-4-5', 64000],
    ['claude-opus-4-5', 64000],
    ['claude-haiku-4-5', 64000],
    ['claude-opus-4-20250514', 32000],
    ['claude-opus-4-1', 32000],
    ['claude-opus-4-1/claude-sonnet-4-20250514', 32000],
    ['claude-opus-4-1/claude-sonnet-4-5', 64000],
    ['claude-3-haiku-20240307', 4096],
    ['claude-3-7-sonnet-20250219', 70000],
    ['gateway-model', 70000],
  ] as const)('keeps thinking below the SDK-clamped total for %s', async (id, maximum) => {
    const body = await requestBody(id, 'high', 70000);
    expect(body.max_tokens).toBe(maximum);
    const thinking = body.thinking as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(thinking.budget_tokens).toBeLessThan(maximum);
  });
  it('leaves answer capacity at the minimum supported legacy thinking total', async () => {
    expect(await requestBody('claude-sonnet-4-20250514', 'high', 1025)).toMatchObject({
      max_tokens: 1025,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    await expect(requestBody('claude-sonnet-4-20250514', 'low', 1024)).rejects.toThrow(
      'at least 1025',
    );
    expect((await requestBody('claude-sonnet-4-20250514', 'instant', 1)).max_tokens).toBe(1);
  });
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid output reservation %s', (total) => {
    expect(() =>
      generationSettings('high', 'anthropic', 'claude-sonnet-4-20250514', total),
    ).toThrow('invalid output limit');
  });
  it.each(['openai', 'google', 'openai-compatible'] as const)(
    'preserves reasoning/output settings for %s',
    (kind) => {
      expect(generationSettings('high', kind, 'model', 4096)).toMatchObject({
        maxOutputTokens: 4096,
        reasoning: 'high',
      });
      if (kind === 'openai-compatible')
        expect(generationSettings('instant', kind, 'model', 4096)).toMatchObject({
          providerOptions: { openaiCompatible: { reasoningEffort: 'none' } },
        });
    },
  );
  it.each(['instant', undefined] as const)(
    'does not expand output when effort is %s',
    async (effort) => {
      expect((await requestBody('claude-sonnet-4-20250514', effort)).max_tokens).toBe(4096);
    },
  );
});

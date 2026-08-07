import { describe, expect, it } from 'vitest';
import { assertReasoningEffortSupported, reasoningCallSettings } from '../../services/reasoning.js';

describe('reasoning effort support', () => {
  it('accepts an effort explicitly enabled by the model catalog', () => {
    expect(() => assertReasoningEffortSupported('high', ['low', 'high'])).not.toThrow();
  });

  it('allows omission so models can use their provider default', () => {
    expect(() => assertReasoningEffortSupported(undefined, [])).not.toThrow();
  });

  it('rejects stale or crafted unsupported effort values', () => {
    expect(() => assertReasoningEffortSupported('high', ['instant', 'low'])).toThrowError(
      'Reasoning effort "high" is not supported by this model',
    );
  });
});

describe('reasoning provider mapping', () => {
  it.each(['openai', 'anthropic', 'google'] as const)(
    'maps OCI instant to explicit none for %s',
    (providerKind) => {
      expect(reasoningCallSettings('instant', providerKind)).toEqual({ reasoning: 'none' });
    },
  );

  it.each(['low', 'medium', 'high'] as const)(
    'passes %s through the provider-neutral AI SDK control',
    (effort) => {
      expect(reasoningCallSettings(effort, 'google')).toEqual({ reasoning: effort });
    },
  );

  it('uses the generic compatible namespace so gateways receive reasoning_effort', () => {
    expect(reasoningCallSettings('high', 'openai-compatible')).toEqual({
      reasoning: 'high',
      providerOptions: { openaiCompatible: { reasoningEffort: 'high' } },
    });
  });

  it('sends explicit none through compatible gateways instead of using their default', () => {
    expect(reasoningCallSettings('instant', 'openai-compatible')).toEqual({
      reasoning: 'none',
      providerOptions: { openaiCompatible: { reasoningEffort: 'none' } },
    });
  });

  it('does not override a provider when effort is omitted', () => {
    expect(reasoningCallSettings(undefined, 'openai-compatible')).toEqual({});
  });
});

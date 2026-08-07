import type { CatalogModel } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  labsFrom,
  matchesCapabilities,
  matchesSearch,
  modelDescription,
} from '../../src/components/chat/model-picker-data';

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'model-1',
    slug: 'test-model',
    displayName: 'Test Reasoner',
    description: null,
    providerId: 'provider-1',
    providerKind: 'openai-compatible',
    providerLabel: 'Test Gateway',
    upstreamModelId: 'test-model',
    capabilities: ['reasoning', 'tool_calling'],
    labId: 'openai',
    costTier: 'medium',
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    isDefault: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe('model picker filtering', () => {
  it('searches model names, providers, descriptions, and lab names', () => {
    const candidate = model({ description: 'Strong at planning' });
    expect(matchesSearch(candidate, 'reasoner')).toBe(true);
    expect(matchesSearch(candidate, 'gateway')).toBe(true);
    expect(matchesSearch(candidate, 'planning')).toBe(true);
    expect(matchesSearch(candidate, 'openai')).toBe(true);
    expect(matchesSearch(candidate, 'unrelated')).toBe(false);
  });

  it('supports any and all capability matching', () => {
    const candidate = model();
    expect(matchesCapabilities(candidate, ['vision', 'reasoning'], false)).toBe(true);
    expect(matchesCapabilities(candidate, ['vision', 'reasoning'], true)).toBe(false);
    expect(matchesCapabilities(candidate, ['reasoning', 'tool_calling'], true)).toBe(true);
  });

  it('deduplicates and alphabetizes the visible lab rail', () => {
    const labs = labsFrom([
      model({ id: '1', labId: 'openai' }),
      model({ id: '2', labId: 'nvidia' }),
      model({ id: '3', labId: 'openai' }),
    ]);
    expect(labs.map((lab) => lab.id)).toEqual(['nvidia', 'openai']);
  });

  it('prefers configured descriptions and otherwise describes capabilities', () => {
    expect(modelDescription(model({ description: 'Administrator description' }))).toBe(
      'Administrator description',
    );
    expect(modelDescription(model())).toBe('Supports reasoning, tool calling');
    expect(modelDescription(model({ capabilities: [] }))).toBe('Available through Test Gateway');
  });
});

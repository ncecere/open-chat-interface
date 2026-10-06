import { describe, expect, it } from 'vitest';
import {
  makeDraft,
  type SearchSettings,
  validateDraft,
} from '../../src/routes/admin/search/search-draft';

const saved: SearchSettings = {
  enabled: true,
  provider: 'searxng',
  baseUrl: 'https://search.example.edu',
  hasCredential: false,
  maxResults: 5,
  fallbackProvider: null,
  fallbackBaseUrl: null,
  hasFallbackCredential: false,
};

describe('web search settings validation', () => {
  it('caps Maximum results at 20, what providers return and search asks for (#218)', () => {
    const draft = (maxResults: string) => ({ ...makeDraft(saved, true), maxResults });
    expect(validateDraft(saved, draft('20'), 'keep', '')).toEqual({});
    expect(validateDraft(saved, draft('500'), 'keep', '')).toEqual({
      maxResults: 'Maximum results can be at most 20.',
    });
    expect(validateDraft(saved, draft('0'), 'keep', '')).toEqual({
      maxResults: 'Maximum results must be a positive whole number.',
    });
  });
});

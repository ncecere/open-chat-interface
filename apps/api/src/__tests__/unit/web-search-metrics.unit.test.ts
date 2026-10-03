import { beforeEach, describe, expect, it } from 'vitest';
import { observeWebSearch } from '../../services/observability/events.js';
import { renderMetrics, resetMetrics, webSearches } from '../../services/observability/metrics.js';

describe('web search metrics', () => {
  beforeEach(() => resetMetrics());

  it('counts searches by provider, slot and outcome, and times them', async () => {
    observeWebSearch('searchapi', 'primary', 'failed', 8_000);
    observeWebSearch('brave', 'fallback', 'answered', 900);
    expect(webSearches.get({ provider: 'searchapi', slot: 'primary', outcome: 'failed' })).toBe(1);
    expect(webSearches.get({ provider: 'brave', slot: 'fallback', outcome: 'answered' })).toBe(1);
    const body = await renderMetrics();
    expect(body).toContain(
      'oci_web_searches_total{provider="brave",slot="fallback",outcome="answered"} 1',
    );
    expect(body).toContain(
      'oci_web_search_duration_seconds_count{provider="searchapi",slot="primary"} 1',
    );
  });

  it('collapses an unexpected provider label', () => {
    observeWebSearch('Not A Provider "x"', 'primary', 'answered', -5);
    expect(webSearches.get({ provider: 'other', slot: 'primary', outcome: 'answered' })).toBe(1);
  });
});

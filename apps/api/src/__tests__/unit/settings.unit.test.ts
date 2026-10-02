import { describe, expect, it } from 'vitest';
import { normalizeFeatureSettings } from '../../services/settings.js';

describe('legacy feature settings', () => {
  it('drops the retired personas, canvas and mcp flags from persisted settings', () => {
    const stored = {
      shareLinks: true,
      temporaryChat: true,
      webSearch: true,
      attachments: true,
      branching: true,
      personas: true,
      canvas: false,
      mcp: false,
    };

    expect(normalizeFeatureSettings(stored)).toEqual({
      shareLinks: true,
      temporaryChat: true,
      webSearch: true,
      attachments: true,
      branching: true,
    });
  });
});

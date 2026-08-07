import { describe, expect, it } from 'vitest';
import { normalizeFeatureSettings } from '../../services/settings.js';

describe('legacy feature settings', () => {
  it('drops the retired personas flag from persisted settings', () => {
    const stored = {
      shareLinks: true,
      temporaryChat: true,
      canvas: false,
      mcp: false,
      webSearch: true,
      attachments: true,
      branching: true,
      personas: true,
    };

    expect(normalizeFeatureSettings(stored)).toEqual({
      shareLinks: true,
      temporaryChat: true,
      canvas: false,
      mcp: false,
      webSearch: true,
      attachments: true,
      branching: true,
    });
  });
});

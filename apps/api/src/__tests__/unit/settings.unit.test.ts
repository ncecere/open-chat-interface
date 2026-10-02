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

    expect(normalizeFeatureSettings(stored as never)).toEqual({
      shareLinks: true,
      temporaryChat: true,
      webSearch: true,
      attachments: true,
      branching: true,
      // Saved before v0.9: memory reads as off.
      memory: false,
    });
  });

  it('keeps a saved memory switch', () => {
    const stored = {
      shareLinks: false,
      temporaryChat: false,
      webSearch: false,
      attachments: false,
      branching: false,
      memory: true,
    };
    expect(normalizeFeatureSettings(stored).memory).toBe(true);
  });
});

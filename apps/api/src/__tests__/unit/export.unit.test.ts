import { describe, expect, it } from 'vitest';
import { exportFilename } from '../../services/export.js';

describe('export filenames', () => {
  it('derives a readable name from the conversation title', () => {
    expect(exportFilename('Planning the migration')).toMatch(
      /^planning-the-migration-\d{4}-\d{2}-\d{2}\.md$/,
    );
  });

  it('strips characters that would break a filesystem path', () => {
    const name = exportFilename('../../etc/passwd');
    // A traversal attempt must not survive into the download name.
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('drops quotes that would escape the content-disposition header', () => {
    const name = exportFilename('He said "hello"');
    expect(name).not.toContain('"');
  });

  it('falls back when a title has nothing usable left', () => {
    expect(exportFilename('***')).toMatch(/^conversation-\d{4}-\d{2}-\d{2}\.md$/);
    expect(exportFilename('')).toMatch(/^conversation-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('bounds a very long title', () => {
    const name = exportFilename('word '.repeat(100));
    // Long enough to be useful, short enough for any filesystem.
    expect(name.length).toBeLessThanOrEqual(75);
  });
});

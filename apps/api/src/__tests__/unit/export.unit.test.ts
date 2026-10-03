import { describe, expect, it } from 'vitest';
import { exportFilename, orderedReplyLines, renderMarkdown } from '../../services/export.js';

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

describe('a reply in a Markdown export', () => {
  const step = (id: string, query: string) => ({
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query },
    output: { results: [] },
  });

  it('keeps tool steps and text in the order the reply wrote them', () => {
    const lines = orderedReplyLines([
      { type: 'step-start' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'Let me look.' },
      step('s1', 'one'),
      step('s2', 'two'),
      { type: 'step-start' },
      { type: 'text', text: 'Found it.' },
      { type: 'text', text: 'Anything else?' },
    ]);
    expect(lines).toEqual([
      'Let me look.',
      '',
      "_Searched the web for 'one' · 0 results_\n_Searched the web for 'two' · 0 results_",
      '',
      'Found it.\n\nAnything else?',
      '',
    ]);
  });

  it('puts the tool limit note after the last tool step', () => {
    const markdown = renderMarkdown({ title: 'T', createdAt: new Date() }, [
      {
        role: 'assistant',
        parts: [
          step('s1', 'one'),
          { type: 'text', text: 'Answer.' },
          { type: 'data-tool-limit', data: { reason: 'steps', steps: 1 } },
        ],
        modelSlug: null,
        status: 'complete',
        createdAt: new Date(),
      },
    ]);
    const search = markdown.indexOf("_Searched the web for 'one'");
    const note = markdown.indexOf('_This reply reached the limit of 1 tool steps');
    expect(search).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(search);
    expect(markdown.indexOf('Answer.')).toBeGreaterThan(note);
    expect(markdown).not.toContain('hidden');
  });
});

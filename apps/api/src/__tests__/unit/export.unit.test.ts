import { contentDisposition } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  exportFilename,
  orderedReplyLines,
  renderMarkdown,
  safeTitleSlug,
} from '../../services/export.js';

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

  it('keeps the letters of every script (#361)', () => {
    expect(exportFilename('Walk9 日本語 العربية Русский 📚', 'UTC')).toMatch(
      /^walk9-日本語-العربية-русский-\d{4}-\d{2}-\d{2}\.md$/,
    );
    expect(exportFilename('日本語の宿題')).toMatch(/^日本語の宿題-\d{4}-\d{2}-\d{2}\.md$/);
    expect(exportFilename('واجب الكتابة')).toMatch(/^واجب-الكتابة-\d{4}-\d{2}-\d{2}\.md$/);
    expect(exportFilename('Bibliothèque Été')).toMatch(/^bibliothèque-été-/);
  });

  it('still removes what a file name cannot carry', () => {
    const stem = safeTitleSlug('a/b\\c:d*e?"f<g>h|i\u202ej\u0000k.. 📚');
    expect(stem).toBe('abcdefghijk');
    // Windows device names get a suffix; a bound never splits a character.
    expect(safeTitleSlug('CON')).toBe('con-');
    const long = safeTitleSlug('😀字'.repeat(100) + '字'.repeat(100));
    expect(Array.from(long)).toHaveLength(60);
    expect(long).not.toContain('\ufffd');
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

describe('headings in a Markdown export (#255)', () => {
  const at = new Date('2026-10-05T12:00:00Z');
  const message = (role: 'user' | 'assistant', text: string) => ({
    role,
    parts: [{ type: 'text', text }],
    modelSlug: role === 'assistant' ? 'gpt-4-1-mini' : null,
    status: 'complete',
    createdAt: at,
  });
  /** The export's outline: every heading line outside code, as a table of contents reads it. */
  const outline = (markdown: string) =>
    markdown
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line));

  it("puts a message's own headings under its speaker, keeping code as written", () => {
    const markdown = renderMarkdown(
      { title: 'Colour names', createdAt: at },
      [
        message('user', '# My notes\n\nWhat are the colours?'),
        message(
          'assistant',
          [
            '## Colours',
            '',
            'Red and blue.',
            '',
            '# Summary',
            '',
            '```bash',
            '# a comment, not a heading',
            'echo done',
            '```',
            '',
            'Shades',
            '------',
            '',
            '> ### Quoted',
            '',
            '##### Fine print',
            '',
            '#hashtag is not a heading',
          ].join('\n'),
        ),
      ],
      [],
      undefined,
      new Map([['gpt-4-1-mini', 'GPT-4.1 mini']]),
    );
    expect(outline(markdown)).toEqual([
      '# Colour names',
      '## You',
      '### My notes',
      '## Assistant · GPT-4.1 mini',
      '#### Colours',
      '### Summary',
      '#### Shades',
      '###### Fine print',
    ]);
    expect(markdown).toContain('> ##### Quoted');
    // Fenced code is left exactly as it was.
    expect(markdown).toContain('```bash\n# a comment, not a heading\necho done\n```');
    expect(markdown).toContain('#hashtag is not a heading');
    expect(markdown).not.toContain('------');
  });
});

describe('Content-Disposition (#361)', () => {
  it('sends both filename and an RFC 5987 filename* for a non-Latin name', () => {
    const header = contentDisposition('日本語の宿題-2026-10-07.md');
    expect(header).toBe(
      `attachment; filename="download.md"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%81%AE%E5%AE%BF%E9%A1%8C-2026-10-07.md`,
    );
    // Every character of the header is ASCII, which is what HTTP requires.
    expect([...header].every((c) => c >= ' ' && c <= '~')).toBe(true);
  });

  it('transliterates accented Latin letters in the plain filename and escapes the quote', () => {
    expect(contentDisposition('bibliothèque "x" 100%.md')).toBe(
      `attachment; filename="bibliotheque _x_ 100_.md"; filename*=UTF-8''biblioth%C3%A8que%20%22x%22%20100%25.md`,
    );
  });

  it('can be inline, and keeps a name from becoming a path', () => {
    expect(contentDisposition('../a\r\nb.png', 'inline')).toBe(
      `inline; filename=".._ab.png"; filename*=UTF-8''.._ab.png`,
    );
  });
});

import {
  applyArtifactEdits,
  artifactByteLength,
  artifactOfToolPart,
  blockKind,
  blockTitle,
  cleanArtifactTitle,
  detectArtifactBlocks,
  fencedBlocks,
  MAX_ARTIFACT_BYTES,
  requestedLibraries,
  splitArtifactSegments,
  summarizeToolPart,
  toolLabel,
} from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { diagramGuidance } from '../../services/artifacts/guidance.js';
import { renderMarkdown } from '../../services/export.js';

const fence = (lang: string, body: string, marker = '```') =>
  `${marker}${lang}\n${body}\n${marker}`;
const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `<p>${index}</p>`).join('\n');

describe('fenced blocks', () => {
  it('reads closed top-level fences in order with their offsets', () => {
    const text = `Intro\n${fence('js', 'a()')}\nMiddle\n~~~~ python extra\nprint()\n~~~~\n   \`\`\`\nplain\n   \`\`\``;
    const blocks = fencedBlocks(text);
    expect(blocks.map((block) => [block.fenceIndex, block.lang, block.content])).toEqual([
      [0, 'js', 'a()'],
      [1, 'python', 'print()'],
      [2, '', 'plain'],
    ]);
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe(fence('js', 'a()'));
  });

  it('ignores a fence still open (a reply streaming) and closes only on a matching marker', () => {
    expect(fencedBlocks('```html\n<p>unfinished')).toEqual([]);
    const [block] = fencedBlocks('````md\n```\ninner\n```\n````');
    expect(block?.content).toBe('```\ninner\n```');
    // A backtick fence's info string may not contain backticks.
    expect(fencedBlocks('```a`b\nx\n```')).toHaveLength(0);
  });

  it('handles Windows line endings', () => {
    expect(fencedBlocks('```svg\r\n<svg></svg>\r\n```\r\n')[0]?.content).toBe('<svg></svg>');
  });
});

describe('which blocks become artifacts', () => {
  it('takes HTML documents or long HTML, SVG, and Mermaid of at least three lines', () => {
    expect(blockKind({ lang: 'html', content: '<!DOCTYPE html><p>x</p>' })).toBe('html');
    expect(blockKind({ lang: 'html', content: '<b>short</b>' })).toBeNull();
    expect(blockKind({ lang: 'htm', content: lines(10) })).toBe('html');
    expect(blockKind({ lang: 'html', content: lines(9) })).toBeNull();
    expect(blockKind({ lang: 'html', content: '<svg viewBox="0 0 1 1"></svg>' })).toBe('svg');
    expect(blockKind({ lang: 'svg', content: '<svg/>' })).toBe('svg');
    expect(blockKind({ lang: 'svg', content: 'not svg' })).toBeNull();
    expect(blockKind({ lang: 'xml', content: '<?xml version="1.0"?>\n<svg></svg>' })).toBe('svg');
    expect(blockKind({ lang: '', content: '<svg></svg>' })).toBe('svg');
    expect(blockKind({ lang: 'xml', content: '<note/>' })).toBeNull();
    expect(blockKind({ lang: 'mermaid', content: 'graph TD\nA-->B\nB-->C' })).toBe('mermaid');
    expect(blockKind({ lang: 'mermaid', content: 'graph TD\nA-->B' })).toBeNull();
    expect(blockKind({ lang: 'python', content: lines(40) })).toBeNull();
    expect(blockKind({ lang: 'svg', content: '   ' })).toBeNull();
  });

  it('leaves oversize blocks as code', () => {
    expect(
      blockKind({ lang: 'svg', content: `<svg>${'x'.repeat(MAX_ARTIFACT_BYTES)}</svg>` }),
    ).toBeNull();
  });

  it('keys blocks by their position among all fences, so detection is repeatable', () => {
    const text = [fence('js', 'x'), fence('svg', '<svg/>'), fence('mermaid', 'a\nb\nc')].join('\n');
    expect(detectArtifactBlocks(text).map((block) => block.key)).toEqual(['block:1', 'block:2']);
    expect(detectArtifactBlocks(text)).toEqual(detectArtifactBlocks(text));
  });
});

describe('titles', () => {
  it('uses the content’s own title, cleaned, or a fallback', () => {
    expect(blockTitle('html', '<title> Q3 &amp; <b>Q4</b> </title>')).toBe('Q3 & Q4');
    expect(blockTitle('html', '<h1 class="x">Report</h1>')).toBe('Report');
    expect(blockTitle('html', '<p>none</p>')).toBe('HTML page');
    expect(blockTitle('svg', '<svg><title>Logo</title></svg>')).toBe('Logo');
    expect(blockTitle('svg', '<svg aria-label="Chart of sales"></svg>')).toBe('Chart of sales');
    expect(blockTitle('svg', '<svg></svg>')).toBe('SVG image');
    expect(blockTitle('mermaid', '---\ntitle: Flow\n---\ngraph TD')).toBe('Flow');
    expect(blockTitle('mermaid', 'pie title Pets\n"Dogs" : 3')).toBe('Pets');
    expect(blockTitle('mermaid', '%% note\nsequenceDiagram\nA->>B: hi')).toBe('Sequence diagram');
    expect(blockTitle('mermaid', 'erDiagram\nA ||--o{ B : has')).toBe(
      'Entity relationship diagram',
    );
    expect(blockTitle('mermaid', 'unknownThing')).toBe('Diagram');
  });

  it('keeps titles to one line of at most 120 characters', () => {
    const title = cleanArtifactTitle(`a\n${'b'.repeat(200)}`);
    expect(title).toHaveLength(120);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('\n');
  });
});

describe('segments for renderers', () => {
  it('splits a reply around artifact blocks and keeps everything else', () => {
    const text = `Before\n${fence('svg', '<svg/>')}\nAfter`;
    const segments = splitArtifactSegments(text);
    expect(segments.map((segment) => segment.type)).toEqual(['markdown', 'artifact', 'markdown']);
    expect(segments[1]).toMatchObject({ raw: fence('svg', '<svg/>'), block: { key: 'block:0' } });
    expect(splitArtifactSegments('plain')).toEqual([{ type: 'markdown', text: 'plain' }]);
  });
});

describe('find-and-replace edits', () => {
  it('applies edits in order, each to exactly one place', () => {
    expect(
      applyArtifactEdits('one two three', [
        { find: 'two', replace: '2' },
        { find: '2 three', replace: '2 3' },
      ]),
    ).toEqual({ ok: true, content: 'one 2 3' });
  });

  it('refuses missing, repeated and empty targets', () => {
    expect(applyArtifactEdits('a a', [{ find: 'a', replace: 'b' }])).toMatchObject({ ok: false });
    expect(applyArtifactEdits('a', [{ find: 'z', replace: 'b' }])).toEqual({
      ok: false,
      error: 'Edit 1: the text to find was not found.',
    });
    expect(applyArtifactEdits('a', [{ find: '', replace: 'b' }])).toMatchObject({ ok: false });
  });
});

describe('sizes and libraries', () => {
  it('measures UTF-8 bytes', () => {
    expect(artifactByteLength('abc')).toBe(3);
    expect(artifactByteLength('é')).toBe(2);
    expect(artifactByteLength('€')).toBe(3);
    expect(artifactByteLength('😀')).toBe(4);
    expect(artifactByteLength('\ud800x')).toBe(4);
    expect(artifactByteLength('😀')).toBe(Buffer.byteLength('😀'));
  });

  it('reads known library markers only, once each', () => {
    expect(
      requestedLibraries(
        '<script data-oci-library="d3"></script><script data-oci-library=D3></script><script data-oci-library="evil"></script>',
      ),
    ).toEqual(['d3']);
    expect(requestedLibraries('<script src="https://cdn.test/d3.js"></script>')).toEqual([]);
  });
});

describe('artifact tool steps', () => {
  const created = {
    type: 'tool-create_artifact',
    toolCallId: 'c1',
    state: 'output-available',
    input: { title: 'Plan', kind: 'markdown', content: 'SECRET CONTENT' },
    output: { artifactId: 'a1', title: 'Plan', kind: 'markdown', version: 1, sizeBytes: 3 },
  };

  it('summarise without content', () => {
    expect(summarizeToolPart(created).summary).toBe("Created artifact 'Plan'");
    expect(
      summarizeToolPart({
        type: 'tool-update_artifact',
        toolCallId: 'u1',
        state: 'output-available',
        input: { artifactId: 'a1', edits: [] },
        output: { artifactId: 'a1', title: 'Plan', kind: 'markdown', version: 3 },
      }).summary,
    ).toBe("Updated artifact 'Plan' · version 3");
    expect(
      summarizeToolPart({ ...created, state: 'output-error', output: undefined }).summary,
    ).toBe('Creating an artifact failed');
    expect(
      summarizeToolPart({ type: 'tool-update_artifact', toolCallId: 'u', state: 'input-available' })
        .summary,
    ).toBe('Updating an artifact');
    expect(summarizeToolPart({ ...created, state: 'input-available' }).summary).toBe(
      "Creating artifact 'Plan'",
    );
    expect(JSON.stringify(summarizeToolPart(created))).not.toContain('SECRET');
    expect(toolLabel('create_artifact')).toBe('Create artifact');
  });

  it('name the artifact a finished step made', () => {
    expect(artifactOfToolPart(created)).toEqual({ artifactId: 'a1', title: 'Plan', version: 1 });
    expect(artifactOfToolPart({ ...created, state: 'output-error' })).toBeNull();
    expect(artifactOfToolPart({ ...created, output: { version: 1 } })).toBeNull();
    expect(
      artifactOfToolPart({ type: 'tool-web_search', toolCallId: 'w', state: 'output-available' }),
    ).toBeNull();
  });
});

describe('diagram guidance', () => {
  it('is short, attributed and uses the instance accent', () => {
    const text = diagramGuidance('#123456');
    expect(text).toContain('Diagram Design by Cathryn Lavery, MIT');
    expect(text).toContain('#123456');
    expect(text.length).toBeLessThan(1_200);
  });
});

describe('Markdown export', () => {
  it('names the artifacts each reply made', () => {
    const markdown = renderMarkdown(
      { title: 'T', createdAt: new Date('2026-01-01') },
      [
        {
          id: 'm1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Here.' }],
          modelSlug: null,
          status: 'complete',
          createdAt: new Date(),
        },
      ],
      [
        {
          messageId: 'm1',
          title: 'Chart',
          kind: 'html',
          versions: [
            { version: 1, messageId: 'm1' },
            { version: 2, messageId: 'm2' },
          ],
        },
      ],
    );
    expect(markdown).toContain('_Artifact \u201cChart\u201d (HTML, version 1)_');
    expect(markdown).not.toContain('version 2');
  });
});

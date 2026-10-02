import { describe, expect, it } from 'vitest';
import { textCost } from '../../services/chat/context-budget.js';
import {
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkText,
  MAX_CHUNKS_PER_FILE,
} from '../../services/project-search/chunking.js';
import { projectFileIndexStatus } from '../../services/project-search/indexing.js';
import {
  projectSearchSummary,
  renderPassage,
  selectPassages,
} from '../../services/project-search/passages.js';
import type { RetrievedChunk } from '../../services/project-search/retrieval.js';

function sentences(count: number, prefix = 'Sentence'): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} ${index} talks about something ordinary at length.`,
  ).join(' ');
}

/** Every chunk is exactly its slice, bounded, ordered and overlapping its neighbour. */
function expectWellFormed(text: string, target = CHUNK_TARGET_CHARS) {
  const { chunks } = chunkText(text, { targetChars: target });
  chunks.forEach((chunk, index) => {
    expect(chunk.ordinal).toBe(index);
    expect(chunk.content).toBe(text.slice(chunk.start, chunk.end));
    expect(chunk.content.length).toBeLessThanOrEqual(target);
    expect(chunk.content).toBe(chunk.content.trim());
    if (index > 0) {
      const previous = chunks[index - 1]!;
      expect(chunk.start).toBeGreaterThan(previous.start);
      expect(previous.end - chunk.start).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS);
    }
  });
  // Nothing but whitespace falls between or after the chunks.
  let covered = 0;
  for (const chunk of chunks) {
    expect(text.slice(covered, chunk.start).trim()).toBe('');
    covered = Math.max(covered, chunk.end);
  }
  expect(text.slice(covered).trim()).toBe('');
  return chunks;
}

describe('project file chunking', () => {
  it('returns no chunks for empty or blank text and one for short text', () => {
    expect(chunkText('')).toEqual({ chunks: [], truncated: false });
    expect(chunkText(' \n\t \n')).toEqual({ chunks: [], truncated: false });
    expect(chunkText('  Short note.  ')).toEqual({
      chunks: [{ ordinal: 0, start: 2, end: 13, content: 'Short note.' }],
      truncated: false,
    });
  });

  it('breaks at paragraph boundaries first and overlaps neighbours', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => sentences(5, `P${index}`));
    const text = paragraphs.join('\n\n');
    const chunks = expectWellFormed(text);
    expect(chunks.length).toBeGreaterThan(1);
    // A chunk ends at the end of a paragraph, never mid-word.
    for (const chunk of chunks.slice(0, -1)) {
      expect(text.slice(chunk.end, chunk.end + 2)).toBe('\n\n');
    }
  });

  it('breaks at sentence ends when there are no paragraphs, overlapping by whole sentences', () => {
    const text = sentences(80);
    const chunks = expectWellFormed(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.content.endsWith('.')).toBe(true);
    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;
      const previous = chunks[index - 1]!;
      // The next chunk starts inside the previous one, at a sentence.
      expect(chunk.start).toBeLessThan(previous.end);
      expect(chunk.content.startsWith('Sentence')).toBe(true);
    }
  });

  it('falls back to line breaks, spaces and finally a hard cut that keeps surrogate pairs', () => {
    expectWellFormed(Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n'));
    expectWellFormed(Array.from({ length: 600 }, (_, index) => `word${index}`).join(' '));

    const emoji = '😀'.repeat(1000);
    const chunks = expectWellFormed(emoji, 101);
    for (const chunk of chunks) {
      expect(chunk.content.length % 2).toBe(0);
      expect(chunk.content).toBe('😀'.repeat(chunk.content.length / 2));
    }
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(emoji);
  });

  it('caps the chunks of one file and reports truncation', () => {
    const text = sentences(400);
    const capped = chunkText(text, { maxChunks: 3 });
    expect(capped.chunks).toHaveLength(3);
    expect(capped.truncated).toBe(true);
    expect(chunkText(text).truncated).toBe(false);
    expect(
      chunkText('x'.repeat(10), { targetChars: 2, maxChunks: MAX_CHUNKS_PER_FILE }).chunks,
    ).toHaveLength(5);
  });

  it('works without overlap', () => {
    const text = sentences(60);
    const { chunks } = chunkText(text, { overlapChars: 0 });
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) expect(chunk.start).toBeGreaterThanOrEqual(chunks[index - 1]!.end);
    }
  });
});

function chunk(
  attachmentId: string,
  ordinal: number,
  text: string,
  start: number,
  filename = `${attachmentId}.txt`,
): RetrievedChunk {
  return {
    attachmentId,
    filename,
    ordinal,
    start,
    end: start + text.length,
    content: text,
  };
}

describe('project passage selection', () => {
  const source = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.';
  // Overlapping windows over one source text, as chunking produces them.
  const a0 = chunk('a', 0, source.slice(0, 37), 0);
  const a1 = chunk('a', 1, source.slice(18, 54), 18);
  const a2 = chunk('a', 2, source.slice(38), 38);
  const b0 = chunk('b', 0, 'Bravo file text.', 0);

  it('stitches overlapping neighbours without repeating text, in file then position order', () => {
    const passages = selectPassages([a2, b0, a0, a1], ['b', 'a'], 10_000);
    expect(passages.map((passage) => passage.attachmentId)).toEqual(['b', 'a']);
    expect(passages[1]).toMatchObject({ first: 1, last: 3, start: 0, chunks: 3, text: source });
    expect(renderPassage(passages[1]!)).toBe(`Passages 1–3 of project file "a.txt":\n\n${source}`);
    expect(renderPassage(passages[0]!)).toBe(
      'Passage 1 of project file "b.txt":\n\nBravo file text.',
    );
  });

  it('keeps separate passages for chunks that are not neighbours, and ignores duplicates', () => {
    const passages = selectPassages([a0, a2, a0], ['a'], 10_000);
    expect(passages.map((passage) => [passage.first, passage.last])).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it('takes the best candidates that fit the share and never exceeds it', () => {
    const share = textCost(renderPassage({ ...selectPassages([a1], ['a'], 10_000)[0]! })).units;
    const passages = selectPassages([a1, a0, b0], ['a', 'b'], share + 10);
    // a0 does not fit after a1; the smaller b0 still does not, so only a1.
    expect(passages.map((passage) => `${passage.attachmentId}${passage.first}`)).toEqual(['a2']);
    expect(selectPassages([a1], ['a'], share - 1)).toEqual([]);
    const all = selectPassages([a0, a1, a2, b0], ['a', 'b'], 1_000);
    const total = all.reduce((sum, passage) => sum + textCost(renderPassage(passage)).units, 0);
    expect(total).toBeLessThanOrEqual(1_000);
  });

  it('orders unknown files last and labels names on one line', () => {
    const odd = chunk('z', 4, 'Zulu.', 10, 'two\nlines  name.txt');
    const passages = selectPassages([odd, b0], ['b'], 10_000);
    expect(passages.map((passage) => passage.attachmentId)).toEqual(['b', 'z']);
    expect(renderPassage(passages[1]!)).toBe(
      'Passage 5 of project file "two lines name.txt":\n\nZulu.',
    );
  });

  it('summarises names and passage counts only', () => {
    const passages = selectPassages([a0, a1, b0], ['a', 'b'], 10_000);
    const summary = projectSearchSummary(passages, 'search');
    expect(summary).toEqual({
      mode: 'search',
      files: [
        { name: 'a.txt', passages: 2 },
        { name: 'b.txt', passages: 1 },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('Alpha');
  });

  it('reports index status', () => {
    expect(projectFileIndexStatus(null)).toEqual({ status: 'pending', passages: 0 });
    expect(projectFileIndexStatus(undefined)).toEqual({ status: 'pending', passages: 0 });
    expect(projectFileIndexStatus(0)).toEqual({ status: 'no-text', passages: 0 });
    expect(projectFileIndexStatus(7)).toEqual({ status: 'indexed', passages: 7 });
  });
});

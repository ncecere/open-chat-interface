import { describe, expect, it } from 'vitest';
import { extractText, MAX_EXTRACTED_CHARS } from '../../services/attachments/extract.js';
import { chunkText } from '../../services/project-search/chunking.js';

/** About `chars` of handbook-like Markdown, with one unique fact near the end. */
function handbook(chars: number, factAt: number): string {
  const section = (n: number) =>
    `## Section ${n}\n\nRoutine guidance for the reading rooms, opening hours and loans.\n\n`;
  let text = '';
  // A flag, not `text.includes`: searching the growing text on every pass is
  // quadratic, and took over 5 s on CI runners.
  let factAdded = false;
  for (let n = 1; text.length < chars; n += 1) {
    text += section(n);
    if (text.length >= factAt && !factAdded) {
      factAdded = true;
      text +=
        'The rare-books vault contact is conservator Elspeth Quarrington, extension 4471.\n\n';
    }
  }
  return text;
}

describe('text extracted from large files', () => {
  it('keeps a 1.5 MB text file whole, so project search can reach its end', async () => {
    const source = handbook(1_500_000, 1_200_000);
    const extracted = await extractText('text/markdown', Buffer.from(source));
    expect(extracted?.length).toBe(source.length);

    const { chunks, truncated } = chunkText(extracted ?? '');
    expect(truncated).toBe(false);
    // The QA finding: the fact sat past character 200,000 and was never indexed.
    expect(chunks.some((chunk) => chunk.content.includes('Elspeth Quarrington'))).toBe(true);
  });

  it('stops at the extraction limit, which is above what one file can be split into', async () => {
    const extracted = await extractText('text/plain', Buffer.from('a '.repeat(2_500_000)));
    expect(extracted?.length).toBe(MAX_EXTRACTED_CHARS);
    // The indexer reaches its own limit first and records it, so the Files tab
    // can say that only the start is searchable.
    expect(chunkText(extracted ?? '').truncated).toBe(true);
  });
});

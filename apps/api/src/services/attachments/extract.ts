import { logger } from '../../lib/logger.js';
import { isPdf, isText } from './validate.js';

/**
 * Text kept from one file. Above what project search can split into passages
 * (MAX_CHUNKS_PER_FILE: 2,000 passages, between about 1.3 and 2 million
 * characters depending on how the text breaks), so the indexer decides
 * how much of a large project file is searchable and records when it is not
 * all (`project_file_index.truncated`), which the Files tab shows. It was
 * 200,000, which silently cut large files to their start, with nothing saying
 * so. Chat attachments are bounded separately by the context budget
 * (MAX_INPUT_UNITS): a file this large is never sent to a model whole.
 */
export const MAX_EXTRACTED_CHARS = 4_000_000;

/**
 * Pulls text out of documents so models without native file support still
 * receive the content. Images are handled by vision instead.
 */
export async function extractText(mimeType: string, bytes: Buffer): Promise<string | null> {
  if (isText(mimeType)) {
    return bytes.toString('utf8').slice(0, MAX_EXTRACTED_CHARS);
  }

  if (isPdf(mimeType)) {
    try {
      const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf');
      const document = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractPdfText(document, { mergePages: true });
      const merged = Array.isArray(text) ? text.join('\n\n') : text;
      return merged.trim().slice(0, MAX_EXTRACTED_CHARS) || null;
    } catch (error) {
      logger.warn({ error }, 'PDF text extraction failed');
      return null;
    }
  }

  return null;
}

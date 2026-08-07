import { logger } from '../../lib/logger.js';
import { isPdf, isText } from './validate.js';

const MAX_EXTRACTED_CHARS = 200_000;

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

import { fileTypeFromBuffer } from 'file-type';
import { validationFailed } from '../../lib/errors.js';

/** MIME types whose bytes carry no reliable signature. */
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/x-markdown',
]);

export interface ValidatedFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

function sanitizeFilename(name: string): string {
  // Strip any directory component a client may have supplied.
  const base = name.split(/[/\\]/).pop() ?? 'file';
  const printable = [...base].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');
  return printable.slice(0, 200) || 'file';
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeText(bytes: Buffer): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeText(bytes: Buffer): boolean {
  const decoded = decodeText(bytes);
  if (decoded === null) return false;

  const sample = decoded.slice(0, 4096);
  let controls = 0;
  for (const character of sample) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    if (!allowedWhitespace && (codePoint < 32 || codePoint === 127)) controls += 1;
  }

  return controls / Math.max(sample.length, 1) < 0.02;
}

/**
 * Validates an upload against the instance policy. The declared content type is
 * never trusted: binary formats are confirmed by magic bytes and text formats
 * by a printable-character heuristic.
 */
export async function validateUpload(params: {
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
  allowedMimeTypes: string[];
  maxFileBytes: number;
}): Promise<ValidatedFile> {
  const filename = sanitizeFilename(params.filename);

  if (params.bytes.byteLength === 0) {
    throw validationFailed(`${filename} is empty`);
  }
  if (params.bytes.byteLength > params.maxFileBytes) {
    const limitMb = Math.round(params.maxFileBytes / (1024 * 1024));
    throw validationFailed(`${filename} exceeds the ${limitMb} MB limit`);
  }

  const detected = await fileTypeFromBuffer(params.bytes);
  const declared = params.declaredMimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  let mimeType: string;

  if (detected) {
    // Binary formats must match their signature, not their declared type.
    mimeType = detected.mime;
  } else if (TEXT_TYPES.has(declared) && looksLikeText(params.bytes)) {
    mimeType = declared;
  } else if (looksLikeText(params.bytes)) {
    mimeType = 'text/plain';
  } else {
    throw validationFailed(`${filename} has an unrecognized or unsupported format`);
  }

  if (!params.allowedMimeTypes.includes(mimeType)) {
    throw validationFailed(`${filename} is a ${mimeType} file, which is not allowed here`);
  }

  if (mimeType === 'application/json') {
    try {
      JSON.parse(decodeText(params.bytes) ?? '');
    } catch {
      throw validationFailed(`${filename} does not contain valid JSON`);
    }
  }

  return { filename, mimeType, bytes: params.bytes };
}

export const isImage = (mimeType: string) => mimeType.startsWith('image/');
export const isPdf = (mimeType: string) => mimeType === 'application/pdf';
export const isText = (mimeType: string) =>
  mimeType.startsWith('text/') || mimeType === 'application/json';

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

/** Kinds of file people know by name, for refusals; a MIME type means little to most (#180). */
const FILE_KINDS: Array<[pattern: RegExp, kind: string]> = [
  [
    /^application\/(x-msdownload|x-msdos-program|vnd\.microsoft\.portable-executable|x-dosexec)$/,
    'a Windows program',
  ],
  [/^application\/(x-executable|x-elf|x-mach-binary|x-sharedlib)$/, 'a program'],
  [/^application\/(zip|x-zip-compressed)$/, 'a ZIP archive'],
  [
    /^application\/(x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-gzip|x-tar|x-bzip2|x-xz|zstd)$/,
    'a compressed archive',
  ],
  [/^application\/pdf$/, 'a PDF'],
  [
    /^application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/,
    'a Word document',
  ],
  [
    /^application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/,
    'a spreadsheet',
  ],
  [
    /^application\/(vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation)$/,
    'a presentation',
  ],
  [/^video\//, 'a video'],
  [/^audio\//, 'an audio file'],
];

/** "a PNG image", "a Windows program", or null for a type with no common name. */
export function fileKind(mimeType: string): string | null {
  for (const [pattern, kind] of FILE_KINDS) if (pattern.test(mimeType)) return kind;
  const image = /^image\/(?:x-|vnd\.)?([\w.+-]+)$/.exec(mimeType)?.[1];
  if (image) {
    const name = image.replace(/\+xml$/, '').toUpperCase();
    return `${/^[AEFILMNORSX]/.test(name) ? 'an' : 'a'} ${name} image`;
  }
  return null;
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
    const kind = fileKind(mimeType);
    throw validationFailed(
      kind
        ? `${filename} is ${kind}, which is not allowed here`
        : `${filename} is a type of file that is not allowed here`,
    );
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

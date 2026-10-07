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

/** What people call each allowed kind of file, for saying what may be attached. */
const ALLOWED_KINDS: Array<[pattern: RegExp, kinds: string]> = [
  [/^image\//, 'images'],
  [/^application\/pdf$/, 'PDFs'],
  [/^(text\/|application\/json$)/, 'text files'],
  [/wordprocessingml|^application\/msword$/, 'Word documents'],
  [/spreadsheetml|^application\/vnd\.ms-excel$/, 'spreadsheets'],
  [/presentationml|^application\/vnd\.ms-powerpoint$/, 'presentations'],
];

/** "You can attach images, PDFs and text files.", or null when none has a common name. */
export function allowedKindsSentence(allowedMimeTypes: string[]): string | null {
  const kinds = ALLOWED_KINDS.filter(([pattern]) =>
    allowedMimeTypes.some((type) => pattern.test(type)),
  ).map(([, kinds]) => kinds);
  if (kinds.length === 0) return null;
  const list =
    kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}`;
  return `You can attach ${list}.`;
}

/** A size limit as people set it: "20 MB", "1.5 MB", "512 KB", without a stray ".0". */
function limitText(bytes: number): string {
  const [unit, size] = bytes >= 1024 * 1024 ? ['MB', 1024 * 1024] : ['KB', 1024];
  return `${Number((bytes / size).toFixed(1))} ${unit}`;
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
    throw validationFailed(`${filename} is empty, so it was not uploaded.`);
  }
  // Whole sentences, worded as the composer's own checks are (#209).
  if (params.bytes.byteLength > params.maxFileBytes) {
    throw validationFailed(
      `${filename} is larger than the ${limitText(params.maxFileBytes)} limit, so it was not uploaded.`,
    );
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
    throw validationFailed(
      `${filename} has an unrecognised or unsupported format, so it was not uploaded.`,
    );
  }

  if (!params.allowedMimeTypes.includes(mimeType)) {
    const kind = fileKind(mimeType);
    const allowed = allowedKindsSentence(params.allowedMimeTypes);
    throw validationFailed(
      [
        kind
          ? `${filename} is ${kind}, which is not allowed here.`
          : `${filename} is a type of file that is not allowed here.`,
        allowed,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  if (mimeType === 'application/json') {
    try {
      JSON.parse(decodeText(params.bytes) ?? '');
    } catch {
      throw validationFailed(`${filename} does not contain valid JSON.`);
    }
  }

  return { filename, mimeType, bytes: params.bytes };
}

export const isImage = (mimeType: string) => mimeType.startsWith('image/');
export const isPdf = (mimeType: string) => mimeType === 'application/pdf';
export const isText = (mimeType: string) =>
  mimeType.startsWith('text/') || mimeType === 'application/json';

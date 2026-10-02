import { JSONParser } from '@streamparser/json';
import { Unzip, type UnzipFile, UnzipInflate } from 'fflate';

/** A problem with the uploaded file itself; its message is safe to show the person. */
export class ImportRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejected';
  }
}

export interface ReaderLimits {
  /** Total decompressed bytes across every entry, nested archives included. */
  maxUncompressedBytes: number;
  /** Decompressed bytes per compressed byte read, once past `ratioGraceBytes`. */
  maxCompressionRatio: number;
  ratioGraceBytes: number;
  maxEntries: number;
  /** Largest single non-conversation file buffered whole (the manifest). */
  maxManifestBytes: number;
}

export const DEFAULT_READER_LIMITS: ReaderLimits = {
  maxUncompressedBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioGraceBytes: 64 * 1024 * 1024,
  maxEntries: 50_000,
  maxManifestBytes: 4 * 1024 * 1024,
};

interface ReadReport {
  container: 'zip' | 'json';
  /** Every entry name seen, nested archive entries prefixed with their archive. */
  entries: string[];
  conversationFiles: string[];
  /** Conversation files the ChatGPT export manifest lists but the archive lacks. */
  missingFiles: string[];
}

/** Rejects absolute paths, drive letters, NUL bytes and any `..` segment. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\u0000')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

type EntryKind = 'conversations' | 'manifest' | 'nested-zip' | 'other';

function classify(name: string, depth: number): EntryKind {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.endsWith('/')) return 'other';
  const segments = normalized.split('/');
  const base = segments.at(-1) ?? '';
  // Exports are sometimes re-zipped inside one top-level folder.
  const shallow = segments.length <= 3;
  if (shallow && /^conversations(-\d+)?\.json$/i.test(base)) return 'conversations';
  if (shallow && base.toLowerCase() === 'export_manifest.json') return 'manifest';
  // Privacy Portal exports wrap the conversations archive inside another zip.
  if (depth === 0 && /\.zip$/i.test(base) && /conversation/i.test(base)) return 'nested-zip';
  return 'other';
}

function baseName(name: string): string {
  return name.replace(/\\/g, '/').split('/').at(-1) ?? name;
}

/** Conversation file names listed in a ChatGPT `export_manifest.json`. */
function manifestConversationFiles(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const logical = (manifest as { logical_files?: Record<string, { files?: unknown }> })
    .logical_files;
  const files = logical?.['conversations.json']?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    if (typeof file === 'string') return [baseName(file)];
    if (typeof file === 'object' && file !== null) {
      const candidate =
        (file as Record<string, unknown>).name ??
        (file as Record<string, unknown>).path ??
        (file as Record<string, unknown>).file_name;
      return typeof candidate === 'string' ? [baseName(candidate)] : [];
    }
    return [];
  });
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function sniff(head: Uint8Array): 'zip' | 'json' | null {
  if (ZIP_MAGIC.every((byte, index) => head[index] === byte)) return 'zip';
  let index = 0;
  // UTF-8 byte-order mark.
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) index = 3;
  while (index < head.length && [0x20, 0x09, 0x0a, 0x0d].includes(head[index] as number)) {
    index += 1;
  }
  const first = head[index];
  return first === 0x5b || first === 0x7b ? 'json' : null;
}

/**
 * Reads an uploaded export as a stream and hands each conversation object to
 * `onConversation`, awaiting it before reading further so database writes
 * apply backpressure to decompression.
 *
 * Accepts the export `.zip` (ChatGPT or Claude, including ChatGPT's split
 * `conversations-NNN.json` layout and one level of nested archive) or a bare
 * `conversations.json`. Nothing is extracted to disk. Decompressed bytes are
 * counted as they are produced, so a zip bomb is stopped by its actual output
 * rather than by sizes the archive claims about itself.
 */
export async function readExport(
  source: AsyncIterable<Uint8Array | Buffer | string>,
  onConversation: (value: unknown) => Promise<void>,
  limits: ReaderLimits = DEFAULT_READER_LIMITS,
): Promise<ReadReport> {
  const report: ReadReport = {
    container: 'json',
    entries: [],
    conversationFiles: [],
    missingFiles: [],
  };
  const queue: unknown[] = [];
  let failure: Error | null = null;
  let compressedIn = 0;
  let uncompressedOut = 0;
  let entryCount = 0;
  let manifestFiles: string[] | null = null;

  const fail = (error: Error) => {
    failure ??= error;
  };

  const account = (bytes: number) => {
    uncompressedOut += bytes;
    if (uncompressedOut > limits.maxUncompressedBytes) {
      fail(new ImportRejected('The archive expands to more data than an import may contain.'));
    } else if (
      uncompressedOut > limits.ratioGraceBytes &&
      uncompressedOut > compressedIn * limits.maxCompressionRatio
    ) {
      fail(new ImportRejected('The archive is compressed suspiciously well and was rejected.'));
    }
  };

  const makeParser = (file: string) => {
    const parser = new JSONParser({ paths: ['$.*'], keepStack: false });
    parser.onValue = ({ value }) => {
      queue.push(value);
    };
    parser.onError = () => fail(new ImportRejected(`${baseName(file)} is not valid JSON.`));
    return parser;
  };

  const drain = async () => {
    while (queue.length > 0 && !failure) {
      await onConversation(queue.shift());
    }
    if (failure) throw failure;
  };

  const makeUnzip = (depth: number, prefix: string): Unzip => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file: UnzipFile) => {
      if (failure) return;
      const name = file.name;
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail(new ImportRejected('The archive contains too many files.'));
        return;
      }
      if (!isSafeEntryName(name)) {
        fail(new ImportRejected('The archive contains an unsafe file path and was rejected.'));
        return;
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxUncompressedBytes) {
        fail(new ImportRejected('The archive expands to more data than an import may contain.'));
        return;
      }
      report.entries.push(prefix + name);
      const kind = classify(name, depth);

      if (kind === 'conversations') {
        report.conversationFiles.push(prefix + name);
        const parser = makeParser(name);
        file.ondata = (error, data, final) => {
          if (failure) return;
          if (error) return fail(new ImportRejected(`${baseName(name)} could not be read.`));
          account(data.byteLength);
          if (failure) return;
          if (data.byteLength > 0) parser.write(data);
          if (final && !parser.isEnded) parser.end();
        };
      } else if (kind === 'manifest') {
        const chunks: Uint8Array[] = [];
        let size = 0;
        file.ondata = (error, data, final) => {
          if (failure || error) return;
          account(data.byteLength);
          size += data.byteLength;
          if (size > limits.maxManifestBytes) return;
          chunks.push(data);
          if (final) {
            try {
              manifestFiles = manifestConversationFiles(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              );
            } catch {
              // A damaged manifest only loses the completeness check.
            }
          }
        };
      } else if (kind === 'nested-zip') {
        const nested = makeUnzip(depth + 1, `${name}/`);
        file.ondata = (error, data, final) => {
          if (failure) return;
          if (error) return fail(new ImportRejected(`${baseName(name)} could not be read.`));
          account(data.byteLength);
          if (failure) return;
          nested.push(data, final);
        };
      } else {
        // Started anyway: an unstarted entry is buffered by the unzipper.
        file.ondata = (error, data) => {
          if (!error && data) account(data.byteLength);
        };
      }
      file.start();
    };
    return unzip;
  };

  let mode: 'zip' | 'json' | null = null;
  let head = new Uint8Array(0);
  let unzip: Unzip | null = null;
  let parser: JSONParser | null = null;

  const feed = (chunk: Uint8Array, final: boolean) => {
    try {
      if (mode === 'zip') {
        compressedIn += chunk.byteLength;
        (unzip as Unzip).push(chunk, final);
      } else {
        compressedIn += chunk.byteLength;
        account(chunk.byteLength);
        if (failure) return;
        if (chunk.byteLength > 0) (parser as JSONParser).write(chunk);
        if (final && !(parser as JSONParser).isEnded) (parser as JSONParser).end();
      }
    } catch (error) {
      fail(
        error instanceof ImportRejected
          ? error
          : new ImportRejected(
              mode === 'zip'
                ? 'The archive is damaged or incomplete.'
                : 'The file is not valid JSON.',
            ),
      );
    }
  };

  for await (const raw of source) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : new Uint8Array(raw);
    if (!mode) {
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
      if (head.length < 4 && head.every((byte) => byte !== 0x5b && byte !== 0x7b)) continue;
      mode = sniff(head);
      if (!mode) {
        throw new ImportRejected(
          'Upload the .zip file from ChatGPT or Claude, or the conversations.json inside it.',
        );
      }
      report.container = mode;
      if (mode === 'zip') unzip = makeUnzip(0, '');
      else parser = makeParser('conversations.json');
      const bom = mode === 'json' && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
      feed(bom ? head.subarray(3) : head, false);
    } else {
      feed(chunk, false);
    }
    await drain();
  }

  if (!mode) throw new ImportRejected('The uploaded file is empty.');
  feed(new Uint8Array(0), true);
  await drain();

  if (mode === 'zip' && report.conversationFiles.length === 0) {
    throw new ImportRejected(
      'No conversations.json was found in the archive. Upload the export from ChatGPT or Claude.',
    );
  }
  if (manifestFiles) {
    const seen = new Set(report.conversationFiles.map((name) => baseName(name).toLowerCase()));
    report.missingFiles = (manifestFiles as string[]).filter(
      (file) => !seen.has(file.toLowerCase()),
    );
  }
  return report;
}

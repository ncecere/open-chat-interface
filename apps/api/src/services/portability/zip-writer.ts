import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** Plain ZIP, without ZIP64: both the entry count and offsets have hard ceilings. */
export const ZIP_MAX_ENTRIES = 65_000;

const DOS_EPOCH = Date.UTC(1980, 0, 2);
const DOS_END = Date.UTC(2099, 11, 31);

/**
 * Incremental ZIP writer. Each `add` compresses one entry synchronously and
 * queues its output; `drain` hands the queued bytes to the caller, so a
 * pull-based response stream only ever holds the entry currently being written.
 */
export class ZipStreamWriter {
  private readonly zip: Zip;
  private queued: Uint8Array[] = [];
  private failure: Error | null = null;
  entries = 0;
  uncompressedBytes = 0;

  constructor() {
    this.zip = new Zip((error, chunk, _final) => {
      if (error) this.failure = error;
      else if (chunk) this.queued.push(chunk);
    });
  }

  add(name: string, data: Uint8Array | string, options?: { compress?: boolean; mtime?: Date }) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const file =
      options?.compress === false ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    const mtime = options?.mtime?.getTime();
    // DOS timestamps only cover 1980-2099; anything else would throw.
    if (mtime !== undefined && mtime > DOS_EPOCH && mtime < DOS_END) file.mtime = mtime;
    this.zip.add(file);
    file.push(bytes, true);
    this.entries += 1;
    this.uncompressedBytes += bytes.byteLength;
    this.throwIfFailed();
  }

  end(): void {
    this.zip.end();
    this.throwIfFailed();
  }

  drain(): Uint8Array[] {
    this.throwIfFailed();
    const out = this.queued;
    this.queued = [];
    return out;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

/** A single path segment safe to use inside an archive. */
export function safeEntrySegment(name: string, fallback = 'file'): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 120 - extension.length) + extension;
}

/** Hands out unique names within one folder, appending ` (2)`, ` (3)` and so on. */
export class NameAllocator {
  private readonly used = new Set<string>();

  allocate(name: string): string {
    let candidate = name;
    let counter = 2;
    while (this.used.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      candidate =
        dot > 0 ? `${name.slice(0, dot)} (${counter})${name.slice(dot)}` : `${name} (${counter})`;
      counter += 1;
    }
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

/**
 * Buffered writers for PostgreSQL COPY ... FROM STDIN through postgres.js.
 *
 * Rows are appended synchronously and flushed in roughly 1 MB writes; callers
 * await `maybeFlush()` between entities so backpressure from the server is
 * respected without awaiting once per row.
 */
import { once } from 'node:events';

const FLUSH_BYTES = 1 << 20;
const ESCAPES = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** A value in COPY's text format. */
export function text(value) {
  if (value === null || value === undefined) return '\\N';
  const s = String(value);
  return /[\\\n\r\t]/.test(s) ? s.replace(/[\\\n\r\t]/g, (c) => ESCAPES[c]) : s;
}

/** A JSON document in COPY's text format (JSON.stringify never emits raw control characters). */
export function json(value) {
  if (value === null || value === undefined) return '\\N';
  return JSON.stringify(value).replace(/\\/g, '\\\\');
}

export function ts(ms) {
  return ms === null || ms === undefined ? '\\N' : new Date(ms).toISOString();
}

export function bool(value) {
  return value ? 't' : 'f';
}

async function openCopy(sql, statement) {
  const stream = await sql.unsafe(statement).writable();
  const failed = new Promise((_, reject) => stream.once('error', reject));
  failed.catch(() => {});
  return { stream, failed };
}

export class TextCopy {
  static async open(sql, table, columns) {
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    const { stream, failed } = await openCopy(sql, `copy "${table}" (${quoted}) from stdin`);
    return new TextCopy(table, stream, failed);
  }

  constructor(table, stream, failed) {
    this.table = table;
    this.stream = stream;
    this.failed = failed;
    this.parts = [];
    this.size = 0;
    this.rows = 0;
  }

  /** Appends one row of already-encoded values. */
  row(values) {
    const line = `${values.join('\t')}\n`;
    this.parts.push(line);
    this.size += line.length;
    this.rows++;
  }

  async maybeFlush() {
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  async flush() {
    if (this.size === 0) return;
    const chunk = this.parts.join('');
    this.parts = [];
    this.size = 0;
    if (!this.stream.write(chunk)) {
      await Promise.race([once(this.stream, 'drain'), this.failed]);
    }
  }

  async end() {
    await this.flush();
    await Promise.race([new Promise((resolve) => this.stream.end(resolve)), this.failed]);
    return this.rows;
  }
}

const PGCOPY_SIGNATURE = Buffer.from('PGCOPY\n\xff\r\n\0', 'latin1');
const PG_EPOCH_MS = Date.UTC(2000, 0, 1);

/**
 * Binary COPY for the embedding table, whose vectors would be ten times larger
 * as text. Row layout: attachment_id text, ordinal int4, model_key text,
 * embedding vector, embedded_at timestamptz.
 */
export class EmbeddingCopy {
  static async open(sql, table, dimensions) {
    const { stream, failed } = await openCopy(
      sql,
      `copy "${table}" (attachment_id, ordinal, model_key, embedding, embedded_at) from stdin with (format binary)`,
    );
    const copy = new EmbeddingCopy(stream, failed, dimensions);
    const header = Buffer.alloc(PGCOPY_SIGNATURE.length + 8);
    PGCOPY_SIGNATURE.copy(header, 0);
    copy.parts.push(header);
    copy.size += header.length;
    return copy;
  }

  constructor(stream, failed, dimensions) {
    this.stream = stream;
    this.failed = failed;
    this.dimensions = dimensions;
    this.parts = [];
    this.size = 0;
    this.rows = 0;
  }

  row(attachmentId, ordinal, modelKey, vector, embeddedAtMs) {
    const id = Buffer.from(attachmentId, 'utf8');
    const key = Buffer.from(modelKey, 'utf8');
    const vectorBytes = 4 + 4 * this.dimensions;
    const length = 2 + 4 + id.length + 8 + 4 + key.length + 4 + vectorBytes + 12;
    const buffer = Buffer.allocUnsafe(length);
    let o = buffer.writeInt16BE(5, 0);
    o = buffer.writeInt32BE(id.length, o);
    o += id.copy(buffer, o);
    o = buffer.writeInt32BE(4, o);
    o = buffer.writeInt32BE(ordinal, o);
    o = buffer.writeInt32BE(key.length, o);
    o += key.copy(buffer, o);
    o = buffer.writeInt32BE(vectorBytes, o);
    o = buffer.writeInt16BE(this.dimensions, o);
    o = buffer.writeInt16BE(0, o);
    for (let i = 0; i < this.dimensions; i++) o = buffer.writeFloatBE(vector[i], o);
    o = buffer.writeInt32BE(8, o);
    buffer.writeBigInt64BE(BigInt(Math.round((embeddedAtMs - PG_EPOCH_MS) * 1000)), o);
    this.parts.push(buffer);
    this.size += length;
    this.rows++;
  }

  async maybeFlush() {
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  async flush() {
    if (this.size === 0) return;
    const chunk = Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (!this.stream.write(chunk)) {
      await Promise.race([once(this.stream, 'drain'), this.failed]);
    }
  }

  async end() {
    const trailer = Buffer.alloc(2);
    trailer.writeInt16BE(-1, 0);
    this.parts.push(trailer);
    this.size += 2;
    await this.flush();
    await Promise.race([new Promise((resolve) => this.stream.end(resolve)), this.failed]);
    return this.rows;
  }
}

export interface StoredObject {
  key: string;
  sizeBytes: number;
}

export interface ListedObject {
  key: string;
  sizeBytes: number;
  lastModified: Date;
}

export interface ListPage {
  objects: ListedObject[];
  /** Opaque continuation token; absent when the listing is complete. */
  cursor?: string;
}

/**
 * Storage backend contract. Attachments are always served through authorized
 * API routes, so drivers never need to produce public URLs.
 */
export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * Enumerates stored objects a page at a time. Reconciliation needs this to
   * find blobs with no database row; without it orphans are undetectable.
   */
  list(options?: { cursor?: string; limit?: number }): Promise<ListPage>;
  /**
   * Optional streaming variants for objects too large to hold in memory, such
   * as an uploaded export. Callers fall back to `put`/`get` when absent.
   */
  putFile?(key: string, path: string, contentType: string): Promise<StoredObject>;
  getStream?(key: string): Promise<NodeJS.ReadableStream>;
}

/** Namespaces objects by owner so a traversal cannot reach another user. */
export function buildStorageKey(userId: string, attachmentId: string, filename: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  const safeExtension = extension?.replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${userId}/${attachmentId}${safeExtension ? `.${safeExtension}` : ''}`;
}

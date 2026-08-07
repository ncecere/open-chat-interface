export interface StoredObject {
  key: string;
  sizeBytes: number;
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
}

/** Namespaces objects by owner so a traversal cannot reach another user. */
export function buildStorageKey(userId: string, attachmentId: string, filename: string): string {
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  const safeExtension = extension?.replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${userId}/${attachmentId}${safeExtension ? `.${safeExtension}` : ''}`;
}

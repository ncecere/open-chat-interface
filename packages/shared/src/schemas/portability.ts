/**
 * Data portability: exporting everything a person owns and importing their
 * history from ChatGPT or Claude.
 */

/** Largest import upload accepted unless the operator sets IMPORT_MAX_UPLOAD_BYTES. */
export const DEFAULT_IMPORT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/** Version of the `manifest.json` layout written into a full export. */
export const EXPORT_ARCHIVE_VERSION = 1;

export const IMPORT_SOURCES = ['chatgpt', 'claude', 'unknown'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** One import as shown in Settings. */
export interface ConversationImportSummary {
  id: string;
  source: ImportSource;
  status: ImportStatus;
  filename: string;
  sizeBytes: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  formatVersion: string | null;
  warnings: string[];
  /** Content types the importer did not recognise, with how often each appeared. */
  unknownContentTypes: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

import type { EmbeddingGenerationState, PgvectorState } from '@oci/shared';

/**
 * Where project-file passage vectors are stored and searched (v0.11 design,
 * section 8). Every read and write of vectors goes through a `VectorStore`;
 * `PgvectorStore` (pgvector.ts) is the only implementation.
 *
 * PostgreSQL stays the source of truth for passages, files, projects and
 * permissions: a store holds vectors keyed by passage (attachment id and
 * ordinal) and nothing that is not derivable again by embedding the passage.
 *
 * Searches take a mandatory person-and-project filter that the store applies
 * itself, inside the query, from the file rows: a caller cannot ask for
 * vectors without one, and file ids it passes only narrow the search further.
 */

/** One embeddings configuration: provider, model and the vector size it produces. */
export interface EmbeddingConfig {
  providerId: string;
  modelId: string;
  dimensions: number;
  /** Micro-dollars per million input tokens; null records usage at no cost. */
  inputPriceMicros: number | null;
}

/**
 * A generation: one configuration's vectors, in its own table. At most one is
 * `current` (searched) and at most one `filling` (being embedded, written
 * alongside the current one, switched to when it covers every passage).
 */
export interface Generation extends EmbeddingConfig {
  id: number;
  /** `project_file_embedding` for generation 1, `project_file_embedding_g<n>` after. */
  tableName: string;
  /** `provider/model/dimensions`, stored with every vector (embeddings/config.ts). */
  modelKey: string;
  state: EmbeddingGenerationState;
  createdBy: string | null;
  createdAt: Date;
  switchedAt: Date | null;
  switchForced: boolean;
  retiredAt: Date | null;
  dropAfter: Date | null;
  droppedAt: Date | null;
}

/** A passage: one chunk of a project file. */
export interface PassageRef {
  attachmentId: string;
  ordinal: number;
}

export interface PassageVector extends PassageRef {
  vector: number[];
}

/** A passage that has no vector in a generation yet, with what embedding it needs. */
export interface PendingPassage extends PassageRef {
  userId: string;
  organizationId: string;
  content: string;
}

/**
 * The filter every search carries. `personId` and `projectId` are required
 * and enforced by the store; `fileIds`, when given, narrows the search to
 * those files and can never widen it beyond the person's project.
 */
export interface VectorScope {
  personId: string;
  projectId: string;
  fileIds?: string[];
}

export interface VectorHit extends PassageRef {
  /** Cosine distance: 0 is the same direction, 2 the opposite. */
  distance: number;
}

/** How far a generation has got. */
export interface FillProgress {
  /** Passages of live project files. */
  total: number;
  /** Of those, how many have a vector in this generation. */
  embedded: number;
  /** Vectors written in the last `RATE_WINDOW_MINUTES`, per minute. */
  perMinute: number;
}

export interface FailureSummary {
  files: number;
  lastError: string | null;
}

/** Whether a generation's storage exists at the right size. */
export type StorageState = 'ready' | 'missing' | 'mismatch' | 'unavailable';

export interface VectorStoreHealth {
  kind: 'pgvector';
  /** pgvector: not installed, installed but not enabled, or enabled. */
  state: PgvectorState;
  version: string | null;
}

export interface VectorStore {
  readonly kind: 'pgvector';

  /** Whether vectors can be stored at all. Never changes anything. */
  health(): Promise<VectorStoreHealth>;

  // Generation lifecycle ---------------------------------------------------

  /** Every generation, oldest first, dropped ones included (history). */
  listGenerations(): Promise<Generation[]>;
  /** The current and the filling generation, either possibly null. */
  liveGenerations(): Promise<{ current: Generation | null; filling: Generation | null }>;
  /**
   * Records a generation as `current` (only when there is none: the first
   * configuration has nothing to keep serving) or `filling`. A retired or
   * cancelled generation of the same configuration whose table still exists
   * is reused rather than embedded again.
   */
  createGeneration(
    config: EmbeddingConfig,
    options: { state: 'current' | 'filling'; createdBy?: string | null },
  ): Promise<Generation>;
  /** Changes the price recorded for a live generation. */
  setPrice(generationId: number, inputPriceMicros: number | null): Promise<void>;
  /**
   * Creates the generation's storage when missing. Idempotent and safe to run
   * concurrently. Storage of another size is left alone (`mismatch`) unless
   * `replaceMismatched`, which re-creates it empty.
   */
  ensureStorage(
    generation: Generation,
    options?: { replaceMismatched?: boolean },
  ): Promise<'created' | 'recreated' | 'ready' | 'mismatch'>;
  storageState(generation: Generation): Promise<StorageState>;
  fillProgress(generation: Generation): Promise<FillProgress>;
  /** True when every live passage has a vector in this generation. */
  covers(generation: Generation): Promise<boolean>;
  /**
   * Makes a filling generation current and retires the current one (searched
   * no more; its storage dropped after `graceMs`), in one transaction, with
   * `alsoInTransaction` run inside it.
   */
  switchTo(
    generationId: number,
    options: {
      graceMs: number;
      forced: boolean;
      alsoInTransaction?: (tx: TransactionExecutor, next: Generation) => Promise<void>;
    },
  ): Promise<{ current: Generation; retired: Generation | null }>;
  /** Abandons a filling generation; its storage is dropped by `dropStorage`. */
  cancel(generationId: number): Promise<Generation | null>;
  /**
   * Drops a retired generation's storage once its grace period is over, or a
   * cancelled one's at once, and records it as dropped. Generation 1's table
   * (the name the previous release uses) is only dropped when
   * `previousReleaseGone`. Returns false when there was nothing to drop yet.
   */
  dropStorage(generation: Generation, options: { previousReleaseGone: boolean }): Promise<boolean>;

  // Passages -----------------------------------------------------------------

  /**
   * Passages of live project files without a vector in this generation,
   * skipping files still backing off after a failure, at most `limit`,
   * after `after` in passage order when given.
   */
  pendingPassages(
    generation: Generation,
    options: { limit: number; attachmentId?: string; after?: PassageRef },
  ): Promise<PendingPassage[]>;
  /** Writes vectors; a passage's earlier vector in this generation is replaced. */
  upsert(generation: Generation, passages: PassageVector[]): Promise<void>;
  /**
   * Deletes from every generation whose storage exists, in one transaction
   * (the caller's, when given). In PostgreSQL the passage foreign key already
   * removes vectors with their passage in the deleting transaction; these
   * exist for stores outside it, and for callers that must not wait for that.
   */
  deleteByPassage(passages: PassageRef[], tx?: TransactionExecutor): Promise<number>;
  deleteByFile(attachmentIds: string[], tx?: TransactionExecutor): Promise<number>;
  deleteByProject(projectId: string, tx?: TransactionExecutor): Promise<number>;
  deleteByPerson(personId: string, tx?: TransactionExecutor): Promise<number>;
  /** Whether any file in scope has a vector in this generation. */
  hasVectors(generation: Generation, scope: VectorScope): Promise<boolean>;
  /** The passages nearest `vector`, nearest first, within the scope only. */
  search(
    generation: Generation,
    scope: VectorScope,
    vector: number[],
    limit: number,
  ): Promise<VectorHit[]>;

  // Failure bookkeeping (backoff per file and generation) -----------------------

  recordFailure(generation: Generation, attachmentId: string, error: unknown): Promise<void>;
  clearFailure(generation: Generation, attachmentId: string): Promise<void>;
  failureSummary(generation: Generation): Promise<FailureSummary>;
}

/** Anything that can run a statement: the pool or an open transaction. */
export type TransactionExecutor = Pick<typeof import('../../db/index.js').db, 'execute'>;

/** A search without a person and a project. Never reaches the database. */
export class VectorScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorScopeError';
  }
}

/** A generation in the wrong state for what was asked (switch a non-filling one, ...). */
export class GenerationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationStateError';
  }
}

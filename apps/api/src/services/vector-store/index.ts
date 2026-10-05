import { PgvectorStore } from './pgvector.js';
import type { VectorStore } from './types.js';

export type {
  EmbeddingConfig,
  FailureSummary,
  FillProgress,
  Generation,
  PassageRef,
  PassageVector,
  PendingPassage,
  StorageState,
  VectorHit,
  VectorScope,
  VectorStore,
  VectorStoreHealth,
} from './types.js';
export { GenerationStateError, VectorScopeError } from './types.js';

let store: VectorStore | null = null;

/**
 * The vector store every caller uses. pgvector is the only store in v0.11;
 * an optional Qdrant store (design section 8) would be chosen here.
 */
export function vectorStore(): VectorStore {
  store ??= new PgvectorStore();
  return store;
}

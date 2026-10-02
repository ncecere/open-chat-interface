import { MockEmbeddingModelV4 } from 'ai/test';

/**
 * A deterministic embeddings model for tests: words that mean the same thing
 * (by the small thesaurus below) land on the same dimension, so a paraphrase
 * is close in meaning to the passage it paraphrases even when they share no
 * word. Other words are hashed onto the remaining dimensions with a small
 * weight, and every vector carries a small constant so none is all zeros.
 *
 * Usage reports one token per word, so attribution can be checked exactly.
 */
const CONCEPTS: string[][] = [
  ['heater', 'heating', 'boiler', 'furnace', 'warming', 'warm'],
  ['password', 'passphrase', 'secret', 'code', 'codeword'],
  ['startup', 'start', 'ignition', 'ignite', 'begin', 'begins', 'commence'],
  ['greenhouse', 'conservatory', 'glasshouse', 'orangery'],
  ['kitchen', 'rota', 'cooking', 'dishes', 'upkeep', 'pantry'],
  ['inventory', 'stock', 'catalogue', 'ledger'],
];
const CONCEPT_OF = new Map(
  CONCEPTS.flatMap((words, index) => words.map((word) => [word, index] as const)),
);

export const FAKE_EMBEDDING_DIMENSIONS = 16;

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

function hash(word: string): number {
  let value = 0;
  for (const char of word) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

export function fakeVector(text: string, dimensions = FAKE_EMBEDDING_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  vector[dimensions - 1] = 0.01;
  const hashed = dimensions - 1 - CONCEPTS.length;
  for (const word of words(text)) {
    const concept = CONCEPT_OF.get(word);
    if (concept !== undefined) vector[concept]! += 1;
    else vector[CONCEPTS.length + (hash(word) % hashed)]! += 0.05;
  }
  return vector;
}

export interface FakeEmbeddingModel extends MockEmbeddingModelV4 {
  /** Every value embedded, in call order. */
  embedded: string[];
  /** When set, every call fails with this error. */
  failWith: Error | null;
}

export function fakeEmbeddingModel(
  options: { modelId?: string; dimensions?: number; maxEmbeddingsPerCall?: number } = {},
): FakeEmbeddingModel {
  const dimensions = options.dimensions ?? FAKE_EMBEDDING_DIMENSIONS;
  const model = new MockEmbeddingModelV4({
    provider: 'fake',
    modelId: options.modelId ?? 'fake-embed',
    maxEmbeddingsPerCall: options.maxEmbeddingsPerCall ?? 2048,
    doEmbed: async ({ values }) => {
      if (fake.failWith) throw fake.failWith;
      fake.embedded.push(...values);
      return {
        embeddings: values.map((value) => fakeVector(value, dimensions)),
        usage: { tokens: values.reduce((sum, value) => sum + words(value).length, 0) },
        warnings: [],
      };
    },
  }) as FakeEmbeddingModel;
  const fake = model;
  fake.embedded = [];
  fake.failWith = null;
  return fake;
}

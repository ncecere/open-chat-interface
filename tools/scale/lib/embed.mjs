/**
 * A deterministic stand-in for an embeddings model: the hashing trick over
 * lower-cased words, normalised to unit length. Passages and questions that
 * share words point in similar directions, so meaning-based search returns
 * plausible neighbours, and the generator and the stub model produce the same
 * vector for the same text without talking to each other.
 */
import { hashString } from './prng.mjs';

export function embedText(text, dimensions) {
  const vector = new Float32Array(dimensions);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of words) {
    const h = hashString(token);
    vector[h % dimensions] += h & 1 ? 1 : -1;
    vector[(h >>> 11) % dimensions] += h & 2 ? 0.5 : -0.5;
  }
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vector[i] * vector[i];
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < dimensions; i++) vector[i] *= scale;
  return vector;
}

/** Rough token count, as providers report it: about four characters a token. */
export function approximateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

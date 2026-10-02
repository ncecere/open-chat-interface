/**
 * Reciprocal rank fusion: merges several best-first rankings of the same
 * items into one. An item scores the sum of `1 / (k + rank)` over the rankings
 * it appears in (rank counted from 1), so being near the top of either list
 * matters more than raw scores, which are not comparable between keyword and
 * vector search. With the customary k = 60, an item first in one list and
 * merely present in the other beats one first in a single list: exact names
 * and codes found by keyword search keep their place while paraphrases found
 * by meaning still rise.
 *
 * Ties keep the order items were first seen in, earlier rankings first, so the
 * result is deterministic.
 */
export const RRF_K = 60;

export function fuseRankings<T>(
  rankings: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  limit: number,
  k = RRF_K,
): T[] {
  const entries = new Map<string, { item: T; score: number; seen: number }>();
  let seen = 0;
  for (const ranking of rankings) {
    const counted = new Set<string>();
    ranking.forEach((item, index) => {
      const key = keyOf(item);
      // A ranking that lists an item twice counts its best position only.
      if (counted.has(key)) return;
      counted.add(key);
      const entry = entries.get(key);
      const score = 1 / (k + index + 1);
      if (entry) entry.score += score;
      else entries.set(key, { item, score, seen: seen++ });
    });
  }
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || a.seen - b.seen)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

/** How many of each ranking's best results are fused first. */
export const HYBRID_TOP_K = 20;

/**
 * The ranking a turn uses: the fusion of the keyword top-K and the vector
 * top-K first, then everything else from both lists (fused the same way) to
 * fill whatever room the budget has left.
 *
 * Fusing only the top of each list matters. A vector search returns every
 * embedded passage in some order, so fused over whole lists any passage that
 * merely shares a common word with the message would appear in both and
 * outrank the passage closest in meaning, which keyword search missed.
 */
export function hybridRanking<T>(
  keyword: readonly T[],
  vector: readonly T[],
  keyOf: (item: T) => string,
  limit: number,
  topK = HYBRID_TOP_K,
): T[] {
  const head = fuseRankings([keyword.slice(0, topK), vector.slice(0, topK)], keyOf, limit);
  const chosen = new Set(head.map(keyOf));
  const tail = fuseRankings([keyword, vector], keyOf, keyword.length + vector.length).filter(
    (item) => !chosen.has(keyOf(item)),
  );
  return [...head, ...tail].slice(0, Math.max(0, limit));
}

/**
 * Relevance floors of project search (v0.9). Each stage of the search keeps
 * only candidates that are plausibly about the latest message, so a question
 * the project's files do not cover adds no passages at all instead of filling
 * the passage share with whatever shares a word with it. See
 * docs/dev/v0.9-design.md, "Relevance floors".
 *
 * Every threshold is relative (to the project's own chunks, to the best match,
 * or to a score scale the model defines), never an absolute keyword score,
 * whose size depends on how many chunks a project has.
 */

/**
 * Keyword search: a word qualifies a chunk only if it is in at most this share
 * of the project's chunks. Words found in more of them, such as "the", "in" and
 * a handbook's own "staff" or "office", still add to a qualifying chunk's
 * score but can never bring a chunk in on their own. Topic words sit well
 * below it: in the 296-chunk handbook and guide used to tune this, "leave" is
 * in 6% of chunks, "data" in 13%, and the most common words ("in", "for",
 * "the") in 54–100%. English stop words never qualify a chunk either (see
 * `SearchTerm`), since in some files even "what" or "about" is rare.
 */
export const KEYWORD_DISTINCTIVE_MAX_SHARE = 0.25;

/**
 * Keyword search: however small the project, a word in at most this many
 * chunks is distinctive. A project is searched only when its files do not fit
 * whole, which for a small model can mean a handful of chunks, where a
 * quarter of them would leave no word distinctive at all.
 */
export const KEYWORD_DISTINCTIVE_MIN_CHUNKS = 3;

/**
 * Keyword search: a qualifying chunk is kept only if it scores at least this
 * fraction of the best chunk's score, so one strong match does not drag in a
 * long tail of chunks that share a single, weaker word with the question
 * (the Harlow Room's key versus every "meeting room": 31%; a data management
 * plan versus every "data protection" section: 26%). Low enough that a
 * question about two topics keeps both (parking permits versus annual leave:
 * 46%), and a chunk mentioning the topic once keeps its place (41%).
 */
export const KEYWORD_RELATIVE_FLOOR = 0.35;

/**
 * Meaning-based search: chunks less similar to the question than this cosine
 * similarity are not candidates. Where "unrelated" falls depends on the
 * embeddings model: OpenAI's text-embedding-3 and Cohere's embed-v3 put
 * unrelated text at about 0–0.2 and relevant passages above about 0.3; other
 * models (such as nomic-embed-text, bge-m3 or ada-002) put even unrelated text
 * at 0.3–0.8, where this floor removes nothing. It is deliberately low:
 * dropping a passage that answers the question costs more than including one
 * that does not, and keyword search and reranking have floors of their own.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.2;

/**
 * Meaning-based search: a chunk is kept only if its similarity is at least
 * this fraction of the best chunk's, as keyword search keeps only chunks near
 * its best (#65). The absolute floor above removes unrelated text but not text
 * on the same topic. Measured in the QA walk's 2,000-passage library handbook
 * with text-embedding-3-small (passages kept at 0.7 / 0.75 / 0.8):
 *
 * - the rare-books vault question: the answer 0.77, its neighbour 0.66, every
 *   other passage (all about the library) 0.36–0.39, and 58 were sent: 2 / 2 / 2;
 * - an after-hours contact question with no answer but the vault's: 28 / 2 / 2;
 * - the vault plus renewing a study carrel, a question about two topics, the
 *   second only in filler at 0.48: 129 / 4 / 2, so above 0.7 the weaker topic
 *   is dropped. Losing a passage that answers costs more than sending one that
 *   does not, as for the floor above.
 *
 * A question no passage stands out for (all about equally similar) keeps them
 * all; only reranking, when it is on, can tell those apart.
 */
export const SEMANTIC_RELATIVE_FLOOR = 0.7;

/**
 * Reranking: candidates the reranking model scores below this are dropped,
 * with everything ranked after them. Cohere-compatible rerankers return a
 * relevance score from 0 to 1, where unrelated text scores close to 0 (Cohere,
 * bge-reranker and Jina models: about 0.0001–0.05). Low, like the
 * meaning-based floor, for the same reason. Applied only when every returned
 * score lies within 0–1; a server returning raw logits is not on that scale,
 * so its order is used as it is.
 */
export const RERANK_MIN_SCORE = 0.05;

/**
 * The best-first `ranked` items that score at least `ratio` of the first
 * item's score. Items must already be sorted by score, highest first.
 */
export function nearBest<T extends { score: number }>(
  ranked: readonly T[],
  ratio = KEYWORD_RELATIVE_FLOOR,
): T[] {
  const best = ranked[0]?.score;
  if (best === undefined || !(best > 0)) return [];
  return ranked.filter((item) => item.score >= best * ratio);
}

/**
 * Cosine distance (pgvector's `<=>`, 1 − similarity) of items similar enough to
 * keep: at least `minSimilarity`, and at least `ratio` of the most similar
 * item's similarity.
 */
export function similarEnough<T extends { distance: number }>(
  nearest: readonly T[],
  minSimilarity = SEMANTIC_MIN_SIMILARITY,
  ratio = SEMANTIC_RELATIVE_FLOOR,
): T[] {
  const kept = nearest.filter((item) => item.distance <= 1 - minSimilarity);
  const best = Math.max(...kept.map((item) => 1 - item.distance));
  return kept.filter((item) => 1 - item.distance >= best * ratio);
}

/**
 * The reranking results to keep: those up to the first scored below
 * `minScore`, or null when the scores are not on the 0–1 relevance scale (or
 * there are none), so the floor does not apply. `ranking` is best first.
 */
export function aboveRerankFloor<T extends { score: number }>(
  ranking: readonly T[],
  minScore = RERANK_MIN_SCORE,
): T[] | null {
  if (ranking.length === 0 || ranking.some((entry) => entry.score < 0 || entry.score > 1)) {
    return null;
  }
  const cut = ranking.findIndex((entry) => entry.score < minScore);
  return cut < 0 ? [...ranking] : ranking.slice(0, cut);
}

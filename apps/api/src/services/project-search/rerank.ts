import { RERANK_CANDIDATES } from '@oci/shared';
import { logger } from '../../lib/logger.js';
import { stripControls } from '../../lib/text.js';
import { getDefaultOrganizationId } from '../organization.js';
import { rerank } from '../reranking/client.js';
import { isRerankingActive, rerankingSettings } from '../reranking/config.js';
import { resolveReranker } from '../reranking/reranker.js';
import { recordRerankUsage } from '../reranking/usage.js';
import { aboveRerankFloor } from './relevance.js';
import type { RetrievedChunk } from './retrieval.js';

/**
 * Optional reranking of project search candidates (v0.9). A cross-encoder
 * reads the question with each of the best candidates (after rank fusion, or
 * keyword ranking alone without meaning-based search) and scores how well it
 * answers it; passages are then chosen in that order. Reranking never fails a
 * reply: any failure keeps the previous order and is logged.
 */

/** Only the start of a long message is sent, as for keyword and meaning-based search. */
const QUERY_MAX_CHARS = 2000;

interface RerankedCandidates {
  candidates: RetrievedChunk[];
  /**
   * Undefined when reranking is off (the note says nothing about it); true
   * when the model reordered the candidates; false when it was configured but
   * could not be used, so the previous order stands.
   */
  reranked: boolean | undefined;
}

/**
 * Reorders the first `RERANK_CANDIDATES` candidates by the reranking model's
 * scores; the rest keep their place after them. Candidates the model did not
 * score follow the scored ones in their previous order. One usage event of
 * the person asking is recorded per reranked message.
 *
 * When the scores are on the usual 0–1 relevance scale and some fall below
 * `RERANK_MIN_SCORE` (relevance.ts), the list ends before the first of them:
 * those candidates, the unscored ones and the rest all rank after a candidate
 * the model judged unrelated. That may leave nothing.
 */
export async function rerankProjectCandidates(
  scope: { userId: string; projectId: string },
  raw: string,
  candidates: RetrievedChunk[],
): Promise<RerankedCandidates> {
  const settings = await rerankingSettings();
  if (!isRerankingActive(settings)) return { candidates, reranked: undefined };
  const query = stripControls(raw.normalize('NFC').slice(0, QUERY_MAX_CHARS)).trim();
  const head = candidates.slice(0, RERANK_CANDIDATES);
  // One candidate (or none) has no order to change, and nothing to send.
  if (!query || head.length < 2) return { candidates, reranked: false };
  try {
    const reranker = await resolveReranker(settings.providerId, settings.modelId);
    const { ranking, tokens } = await rerank({
      ...reranker,
      model: reranker.modelId,
      query,
      documents: head.map((chunk) => chunk.content),
    });
    // No scores at all would leave the order as it was: that is not reranking.
    if (ranking.length === 0) throw new Error(`${reranker.provider} returned no reranking results`);
    await recordRerankUsage({
      organizationId: await getDefaultOrganizationId(),
      userId: scope.userId,
      modelId: reranker.modelId,
      tokens,
      searchPriceMicros: settings.searchPriceMicros,
    });
    const kept = aboveRerankFloor(ranking);
    if (kept && kept.length < ranking.length) {
      return { candidates: kept.map((entry) => head[entry.index]!), reranked: true };
    }
    const scored = new Set(ranking.map((entry) => entry.index));
    const reordered = [
      ...ranking.map((entry) => head[entry.index]!),
      ...head.filter((_, index) => !scored.has(index)),
      ...candidates.slice(RERANK_CANDIDATES),
    ];
    return { candidates: reordered, reranked: true };
  } catch (error) {
    logger.warn(
      { error, projectId: scope.projectId },
      'Reranking project passages failed; using the previous order',
    );
    return { candidates, reranked: false };
  }
}

import { ERROR_CODES } from '@oci/shared';
import type { UIMessage } from 'ai';
import { AppError, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { loadMemorySection, withMemories } from '../memory/prompt.js';
import {
  buildGroundingContext,
  normalizeSearchQuery,
  type SearchResult,
  searchWeb,
} from '../search/index.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { hasTool } from '../tools/registry.js';
import {
  attachmentCost,
  attachmentIds,
  inspectHistoricalAttachments,
  inspectIncomingAttachments,
  materializeAttachments,
  UNAVAILABLE_ATTACHMENT_TEXT,
  withAttachmentContext,
} from './attachment-context.js';
import {
  type ActiveCompaction,
  autoCompactEnabled,
  compactForTurn,
  latestCompaction,
  summaryMaxTokens,
} from './compaction.js';
import { withSummary } from './compaction-plan.js';
import {
  addCost,
  assertFitsContext,
  type ContextCost,
  contextBudget,
  emptyCost,
  fitsContext,
  historyGroups,
  MAX_CONTEXT_FILES,
  MESSAGE_OVERHEAD,
  messageCost,
  selectContextSuffix,
  textCost,
} from './context-budget.js';
import { type ContextMessage, loadContextHistory } from './context-history.js';
import { generationSettings } from './generation-settings.js';
import { historyParts, textFromParts } from './message-parts.js';
import {
  loadProjectContext,
  selectProjectFiles,
  withProjectFiles,
  withProjectInstructions,
} from './project-context.js';
import type { TurnContext } from './turn-context.js';

/** Text and finished tool steps; tool parts stay tool parts only when this turn offers tools. */
const asUI = (message: ContextMessage, toolsOffered: boolean): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: historyParts(message.parts, toolsOffered),
});

/** Budget metadata first. Only selected file payloads reach the storage driver. */
/**
 * The search before a reply, for models without the search tool. A provider
 * failure no longer fails the reply: the model is told the search failed and
 * the reply shows why. Anything else (search switched off) still refuses.
 */
export type PreSearch = { results: SearchResult[]; error?: string };

async function searchOrFailure(query: string): Promise<PreSearch> {
  try {
    return { results: await searchWeb(query) };
  } catch (error) {
    if (error instanceof AppError && error.code !== ERROR_CODES.PROVIDER_ERROR) throw error;
    return {
      results: [],
      error: error instanceof AppError ? error.message : 'The search provider failed.',
    };
  }
}

export type ModelContextOptions = {
  /** The search made for an earlier attempt at this turn, reused instead of searching again. */
  search?: PreSearch;
  /**
   * Rebuilding after the provider reported the input too long: compact first
   * (when automatic compaction is on), keeping at most half of the history.
   */
  compact?: 'overflow';
};

/** Automatic compaction is best effort; a setting that cannot be read leaves it off. */
async function compactionAllowed(threadId: string): Promise<boolean> {
  try {
    return await autoCompactEnabled();
  } catch (error) {
    logger.warn({ error, threadId }, 'Could not read the automatic compaction setting');
    return false;
  }
}

export async function buildModelContext(
  context: TurnContext,
  claimId: string,
  options: ModelContextOptions = {},
) {
  const { input, user, resolved, thread } = context;
  const submitted = input.messages[0];
  if (!submitted) throw validationFailed('A user message is required');
  const budget = contextBudget(resolved);
  const generation = generationSettings(
    input.effort,
    resolved.providerKind,
    typeof resolved.languageModel === 'string'
      ? resolved.languageModel
      : resolved.languageModel.modelId,
    budget.outputTokens,
  );
  const incoming: UIMessage = {
    id: submitted.id ?? crypto.randomUUID(),
    role: 'user',
    parts: submitted.parts,
  };
  assertFitsContext(messageCost(incoming), budget);
  if (input.attachmentIds.length > MAX_CONTEXT_FILES)
    throw validationFailed(`At most ${MAX_CONTEXT_FILES} files fit in model context`);
  if (input.trigger === 'regenerate-message' && input.attachmentIds.length)
    throw validationFailed('Attachments cannot be added while regenerating a response');
  // A compacted conversation is sent as its summary plus the turns from the
  // cut on; the turns before the cut are not even read.
  const previous = await latestCompaction(thread.id, user.id);
  const historyInput = {
    threadId: thread.id,
    userId: user.id,
    claimId,
    latest: incoming,
    regenerate: input.trigger === 'regenerate-message',
    attachmentIds: input.attachmentIds,
  };
  const stored = await loadContextHistory({
    ...historyInput,
    fromPosition: previous?.firstKeptPosition,
  });
  const toolsOffered = context.tools.definitions.length > 0;
  // With the web_search tool the model searches when it chooses; otherwise
  // v0.7's single search before the reply still applies.
  const preSearch = input.webSearch && !hasTool(context.tools, 'web_search');
  const searchQuery = preSearch ? normalizeSearchQuery(textFromParts(stored.latest.parts)) : null;
  const [newCandidates, searchResults, baseSystem, project, memories] = await Promise.all([
    inspectIncomingAttachments(input.attachmentIds, user.id, user.role),
    searchQuery
      ? (options.search ?? searchOrFailure(searchQuery))
      : Promise.resolve<PreSearch>({ results: [] }),
    buildSystemPrompt(user.id, user.name, {
      role: user.role,
      threadId: thread.id,
      artifactTools: hasTool(context.tools, 'create_artifact'),
    }),
    loadProjectContext(thread.projectId, user),
    // Empty unless memory is on for this person and the chat is not temporary.
    loadMemorySection(
      { userId: user.id, role: user.role, temporary: thread.temporary },
      budget.units,
    ),
  ]);
  // Project instructions follow the instance prompt and the person's own
  // customisation, then the person's memories (at most a fixed share of the
  // input budget), so the system prompt's cost below already includes them
  // and a compaction summary is budgeted after them.
  const system = withMemories(withProjectInstructions(baseSystem, project), memories);
  const latest: UIMessage = preSearch
    ? {
        ...stored.latest,
        parts: [
          ...stored.latest.parts,
          { type: 'text', text: buildGroundingContext(searchResults.results, searchResults.error) },
        ],
      }
    : stored.latest;
  const systemCost = { ...textCost(system), units: textCost(system).units + MESSAGE_OVERHEAD };
  assertFitsContext(addCost(systemCost, messageCost(latest)), budget);
  const supportsVision = resolved.capabilities.includes('vision');
  let projectFiles: Awaited<ReturnType<typeof selectProjectFiles>> | undefined;

  /**
   * History as it would be sent with `compaction`: the summary (when it fits
   * beside the required context) and then whole turns, newest first, as the
   * budget allows.
   */
  async function assemble(history: typeof stored, compaction: ActiveCompaction | null) {
    const groups = historyGroups(history.history);
    let fileCount =
      newCandidates.length + (history.target ? attachmentIds(history.target).length : 0);
    if (fileCount > MAX_CONTEXT_FILES)
      throw validationFailed('The requested turn has too many context files');
    let first = groups.length;
    for (let index = groups.length - 1; index >= 0; index--) {
      const count = groups[index]!.reduce((sum, message) => sum + attachmentIds(message).length, 0);
      if (fileCount + count > MAX_CONTEXT_FILES) break;
      fileCount += count;
      first = index;
    }
    const inspectedGroups = groups.slice(first);
    const historical = await inspectHistoricalAttachments(
      [...inspectedGroups.flat(), ...(history.target ? [history.target] : [])],
      user.id,
    );
    const filesCost = (id: string) => {
      let cost = (historical.byMessage.get(id) ?? []).reduce(
        (sum, file) => addCost(sum, attachmentCost(file, supportsVision)),
        emptyCost(),
      );
      if (historical.unavailable.has(id))
        cost = addCost(cost, textCost(UNAVAILABLE_ATTACHMENT_TEXT));
      return cost;
    };
    let required = addCost(systemCost, messageCost(latest));
    required = addCost(
      required,
      history.target
        ? filesCost(history.target.id)
        : newCandidates.reduce(
            (sum, file) => addCost(sum, attachmentCost(file, supportsVision)),
            emptyCost(),
          ),
    );
    // Project files outrank history: they are chosen to fit after the required
    // context, and history is trimmed to what remains. A file that does not fit
    // is left out rather than truncated, and the reply is marked context-limited.
    // Files too large to include whole are searched with the latest message.
    projectFiles ??= await selectProjectFiles(
      project,
      required,
      budget,
      supportsVision,
      textFromParts(history.latest.parts),
    );
    required = addCost(required, projectFiles.cost);
    const beforeSummary = required;
    // The summary stands for the turns before the cut. If even it does not fit
    // beside the required context, those turns are left out unsummarised.
    const summaryCost = compaction ? textCost(withSummary('', compaction.summary)) : emptyCost();
    const summarised = compaction !== null && fitsContext(addCost(required, summaryCost), budget);
    if (summarised) required = addCost(required, summaryCost);
    const selected = selectContextSuffix(
      inspectedGroups.map((items) => ({
        items,
        cost: items.reduce(
          (sum, message) =>
            addCost(sum, addCost(messageCost(asUI(message, toolsOffered)), filesCost(message.id))),
          emptyCost(),
        ),
      })),
      required,
      budget,
    );
    const historyLimited = history.limited || first > 0 || selected.limited;
    return {
      history,
      historical,
      selected,
      beforeSummary,
      compaction: summarised ? compaction : null,
      historyLimited,
      limited:
        historyLimited ||
        groups.flat().length !== history.history.length ||
        (compaction !== null && !summarised),
    };
  }

  let view = await assemble(stored, previous);
  let compacted = false;
  if (
    (options.compact === 'overflow' || view.historyLimited) &&
    (await compactionAllowed(thread.id))
  ) {
    // Keep recent turns up to half the input budget, or less when the system
    // prompt, project files and the new message leave less room for history
    // beside a summary.
    const room = budget.units - view.beforeSummary.units - summaryMaxTokens(budget) * 4;
    const created = await compactForTurn({
      context,
      reason: options.compact === 'overflow' ? 'overflow' : 'automatic',
      previous,
      before: stored.target ?? null,
      excludeIds: [claimId],
      keepUnits: Math.max(0, Math.min(Math.floor(budget.units / 2), room)),
      atMostHalf: options.compact === 'overflow',
    });
    if (created) {
      compacted = true;
      view = await assemble(
        await loadContextHistory({ ...historyInput, fromPosition: created.firstKeptPosition }),
        created,
      );
    }
  }
  const { selected, historical, history } = view;
  const finalSystem = withSummary(system, view.compaction?.summary);
  const finalSystemCost: ContextCost = {
    ...textCost(finalSystem),
    units: textCost(finalSystem).units + MESSAGE_OVERHEAD,
  };
  const latestCandidates = history.target
    ? (historical.byMessage.get(history.target.id) ?? [])
    : newCandidates;
  const historicalCandidates = [
    ...selected.items,
    ...(history.target ? [history.target] : []),
  ].flatMap((message) => historical.byMessage.get(message.id) ?? []);
  const files = projectFiles!;
  const allCandidates = [...newCandidates, ...historicalCandidates, ...files.files];
  const loaded = await materializeAttachments(allCandidates, user.id, user.role, supportsVision);
  const historicalMessage = (message: ContextMessage) =>
    withAttachmentContext(
      asUI(message, toolsOffered),
      (historical.byMessage.get(message.id) ?? []).map((file) => loaded.get(file.id)!),
      supportsVision,
      historical.unavailable.has(message.id),
    );
  const uiMessages = withProjectFiles(
    [
      ...selected.items.map(historicalMessage).filter((message) => message.parts.length),
      withAttachmentContext(
        latest,
        latestCandidates.map((file) => loaded.get(file.id)!),
        supportsVision,
        Boolean(history.target && historical.unavailable.has(history.target.id)),
      ),
    ],
    project,
    files.files.map((file) => loaded.get(file.id)!),
    supportsVision,
    files.search,
  );
  const actualCost = uiMessages.reduce(
    (sum, message) => addCost(sum, messageCost(message)),
    finalSystemCost,
  );
  assertFitsContext({ ...actualCost, files: allCandidates.length }, budget);
  return {
    latest: stored.latest,
    newAttachments: newCandidates.map((file) => loaded.get(file.id)!),
    historicalReferences: historicalCandidates.map((file) => ({
      id: file.id,
      messageId: file.messageId!,
    })),
    uiMessages,
    system: finalSystem,
    outputTokens: budget.outputTokens,
    generationSettings: generation,
    contextLimited: view.limited || files.omitted > 0,
    /** Whether this call recorded a new compaction. */
    compacted,
    /** The search results, so a rebuilt context can reuse them. */
    search: searchResults,
    sourceParts: searchResults.results.map((source, index) => ({
      type: 'source-url' as const,
      sourceId: `search-${index + 1}`,
      url: source.url,
      title: source.title,
    })),
    searchGroundingPart: searchQuery
      ? {
          type: 'data-search-grounding' as const,
          id: `search-grounding-${crypto.randomUUID()}`,
          data: {
            query: searchQuery,
            results: searchResults.results,
            ...(searchResults.error ? { error: searchResults.error } : {}),
          },
        }
      : null,
    projectSearchPart: files.searchPart,
  };
}

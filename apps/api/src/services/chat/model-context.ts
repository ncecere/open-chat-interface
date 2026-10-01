import type { UIMessage } from 'ai';
import { validationFailed } from '../../lib/errors.js';
import { buildGroundingContext, normalizeSearchQuery, searchWeb } from '../search/index.js';
import { buildSystemPrompt } from '../system-prompt.js';
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
  addCost,
  assertFitsContext,
  contextBudget,
  historyGroups,
  MAX_CONTEXT_FILES,
  MESSAGE_OVERHEAD,
  messageCost,
  selectContextSuffix,
  textCost,
} from './context-budget.js';
import { type ContextMessage, loadContextHistory } from './context-history.js';
import { generationSettings } from './generation-settings.js';
import { textFromParts, textParts } from './message-parts.js';
import type { TurnContext } from './turn-context.js';

const asUI = (message: ContextMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: textParts(message.parts),
});

/** Budget metadata first. Only selected file payloads reach the storage driver. */
export async function buildModelContext(context: TurnContext, claimId: string) {
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
  const stored = await loadContextHistory({
    threadId: thread.id,
    userId: user.id,
    claimId,
    latest: incoming,
    regenerate: input.trigger === 'regenerate-message',
    attachmentIds: input.attachmentIds,
  });
  const searchQuery = input.webSearch
    ? normalizeSearchQuery(textFromParts(stored.latest.parts))
    : null;
  const [newCandidates, searchResults, system] = await Promise.all([
    inspectIncomingAttachments(input.attachmentIds, user.id, user.role),
    searchQuery ? searchWeb(searchQuery) : Promise.resolve([]),
    buildSystemPrompt(user.id, user.name),
  ]);
  const latest: UIMessage = input.webSearch
    ? {
        ...stored.latest,
        parts: [
          ...stored.latest.parts,
          { type: 'text', text: buildGroundingContext(searchResults) },
        ],
      }
    : stored.latest;
  const systemCost = { ...textCost(system), units: textCost(system).units + MESSAGE_OVERHEAD };
  assertFitsContext(addCost(systemCost, messageCost(latest)), budget);
  const groups = historyGroups(stored.history);
  let fileCount = newCandidates.length + (stored.target ? attachmentIds(stored.target).length : 0);
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
    [...inspectedGroups.flat(), ...(stored.target ? [stored.target] : [])],
    user.id,
  );
  const supportsVision = resolved.capabilities.includes('vision');
  const latestCandidates = stored.target
    ? (historical.byMessage.get(stored.target.id) ?? [])
    : newCandidates;
  const filesCost = (id: string) => {
    let cost = (historical.byMessage.get(id) ?? []).reduce(
      (sum, file) => addCost(sum, attachmentCost(file, supportsVision)),
      { units: 0, files: 0, imageBytes: 0 },
    );
    if (historical.unavailable.has(id)) cost = addCost(cost, textCost(UNAVAILABLE_ATTACHMENT_TEXT));
    return cost;
  };
  let required = addCost(systemCost, messageCost(latest));
  required = addCost(
    required,
    stored.target
      ? filesCost(stored.target.id)
      : newCandidates.reduce((sum, file) => addCost(sum, attachmentCost(file, supportsVision)), {
          units: 0,
          files: 0,
          imageBytes: 0,
        }),
  );
  const selected = selectContextSuffix(
    inspectedGroups.map((items) => ({
      items,
      cost: items.reduce(
        (sum, message) => addCost(sum, addCost(messageCost(asUI(message)), filesCost(message.id))),
        { units: 0, files: 0, imageBytes: 0 },
      ),
    })),
    required,
    budget,
  );
  const historicalCandidates = [
    ...selected.items,
    ...(stored.target ? [stored.target] : []),
  ].flatMap((message) => historical.byMessage.get(message.id) ?? []);
  const allCandidates = [...newCandidates, ...historicalCandidates];
  const loaded = await materializeAttachments(allCandidates, user.id, user.role, supportsVision);
  const historicalMessage = (message: ContextMessage) =>
    withAttachmentContext(
      asUI(message),
      (historical.byMessage.get(message.id) ?? []).map((file) => loaded.get(file.id)!),
      supportsVision,
      historical.unavailable.has(message.id),
    );
  const uiMessages = [
    ...selected.items.map(historicalMessage).filter((message) => message.parts.length),
    withAttachmentContext(
      latest,
      latestCandidates.map((file) => loaded.get(file.id)!),
      supportsVision,
      Boolean(stored.target && historical.unavailable.has(stored.target.id)),
    ),
  ];
  const actualCost = uiMessages.reduce(
    (sum, message) => addCost(sum, messageCost(message)),
    systemCost,
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
    system,
    outputTokens: budget.outputTokens,
    generationSettings: generation,
    contextLimited:
      stored.limited ||
      groups.flat().length !== stored.history.length ||
      first > 0 ||
      selected.limited,
    sourceParts: searchResults.map((source, index) => ({
      type: 'source-url' as const,
      sourceId: `search-${index + 1}`,
      url: source.url,
      title: source.title,
    })),
    searchGroundingPart: searchQuery
      ? {
          type: 'data-search-grounding' as const,
          id: `search-grounding-${crypto.randomUUID()}`,
          data: { query: searchQuery, results: searchResults },
        }
      : null,
  };
}

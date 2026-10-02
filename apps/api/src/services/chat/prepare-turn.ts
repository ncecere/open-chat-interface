import type { UIMessage } from 'ai';
import type { searchWeb } from '../search/index.js';
import type { generationSettings } from './generation-settings.js';
import { buildModelContext } from './model-context.js';
import { persistTurn } from './persist-turn.js';
import type { ProjectSearchPart } from './project-context.js';
import type { AcquiredRun } from './run-lifecycle.js';
import type { TurnContext } from './turn-context.js';

export type PreparedTurn = TurnContext & {
  promptMessageId: string;
  submittedMessageId: string | null;
  uiMessages: UIMessage[];
  system: string;
  contextLimited?: boolean;
  generationSettings: ReturnType<typeof generationSettings>;
  sourceParts: Array<{ type: 'source-url'; sourceId: string; url: string; title: string }>;
  searchGroundingPart: {
    type: 'data-search-grounding';
    id: string;
    data: { query: string; results: Awaited<ReturnType<typeof searchWeb>> };
  } | null;
  /** Set when project files were searched; names and passage counts only. */
  projectSearchPart?: ProjectSearchPart | null;
};

/** Budget/enrich outside transactions, then commit the unmodified prompt and file references. */
export async function prepareTurn(context: TurnContext, run: AcquiredRun): Promise<PreparedTurn> {
  const model = await buildModelContext(context, run.assistantMessage.id);
  const persisted = await persistTurn(
    context,
    run,
    model.latest,
    model.newAttachments,
    model.latest.id,
    model.historicalReferences,
  );
  return {
    ...context,
    ...persisted,
    // Preserve the reserved total; generationSettings can split it into thinking/answer.
    resolved: { ...context.resolved, maxOutputTokens: model.outputTokens },
    generationSettings: model.generationSettings,
    uiMessages: model.uiMessages,
    system: model.system,
    contextLimited: model.contextLimited,
    sourceParts: model.sourceParts,
    searchGroundingPart: model.searchGroundingPart,
    projectSearchPart: model.projectSearchPart,
  };
}

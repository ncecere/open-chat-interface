import { DEFAULT_MAX_TOOL_STEPS } from '@oci/shared';
import type { UIMessage } from 'ai';
import type { searchWeb } from '../search/index.js';
import type { generationSettings } from './generation-settings.js';
import { buildModelContext } from './model-context.js';
import { persistTurn } from './persist-turn.js';
import type { ProjectSearchPart } from './project-context.js';
import type { AcquiredRun } from './run-lifecycle.js';
import { maxToolSteps } from './tool-loop.js';
import type { TurnContext } from './turn-context.js';

export type PreparedTurn = TurnContext & {
  /** Model steps one reply may take when it uses tools. */
  maxToolSteps: number;
  /**
   * Set when this run continues a reply after its approvals were answered:
   * the same assistant message keeps its parts and gains new ones.
   */
  continuation?: {
    /** Tool calls the person approved, for their audit events. */
    approved: ReadonlySet<string>;
    /** Approved calls refused because the tool is no longer offered. */
    refused: ReadonlySet<string>;
    /** The reply's stored parts before this run. */
    existingParts: readonly unknown[];
  };
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
  const [model, steps] = await Promise.all([
    buildModelContext(context, run.assistantMessage.id),
    // Only a turn that offers tools reads the step limit.
    context.tools.definitions.length ? maxToolSteps() : DEFAULT_MAX_TOOL_STEPS,
  ]);
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
    maxToolSteps: steps,
    uiMessages: model.uiMessages,
    system: model.system,
    contextLimited: model.contextLimited,
    sourceParts: model.sourceParts,
    searchGroundingPart: model.searchGroundingPart,
    projectSearchPart: model.projectSearchPart,
  };
}

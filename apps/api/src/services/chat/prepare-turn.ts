import { DEFAULT_MAX_TOOL_STEPS } from '@oci/shared';
import type { UIMessage } from 'ai';
import type { searchWeb } from '../search/index.js';
import type { CompactionCheck } from './compaction-queue.js';
import type { generationSettings } from './generation-settings.js';
import { textParts } from './message-parts.js';
import { buildModelContext } from './model-context.js';
import { persistTurn } from './persist-turn.js';
import type { ProjectSearchPart } from './project-context.js';
import type { AcquiredRun } from './run-lifecycle.js';
import { maxToolSteps } from './tool-loop.js';
import type { TurnContext } from './turn-context.js';

/** The model input rebuilt with fewer turns after the provider said it was too long. */
export type RecoveredContext = { uiMessages: UIMessage[]; system: string; contextLimited: boolean };

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
  /**
   * After the provider reported the input too long: rebuild the input with at
   * most half of the history it sent, leaving the oldest turns out (no
   * summary call; a background compaction is queued). Null when no history
   * was sent, so there is nothing to leave out. The reply calls it at most once.
   */
  recoverOverflow?: () => Promise<RecoveredContext | null>;
  /** What the turn sent, for queueing a compaction after the reply. */
  compactionCheck?: CompactionCheck;
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
  // The prompt and its files are stored now, so a rebuild reads them back as
  // a retry of this turn would, reusing this turn's search.
  const recoverOverflow = async (): Promise<RecoveredContext | null> => {
    if (model.sentHistoryUnits <= 0) return null;
    const rebuilt = await buildModelContext(
      {
        ...context,
        input: {
          ...context.input,
          trigger: 'regenerate-message',
          attachmentIds: [],
          messages: [
            { id: persisted.promptMessageId, role: 'user', parts: textParts(model.latest.parts) },
          ],
        },
      },
      run.assistantMessage.id,
      { maxHistoryUnits: Math.floor(model.sentHistoryUnits / 2), search: model.search },
    );
    return {
      uiMessages: rebuilt.uiMessages,
      system: rebuilt.system,
      contextLimited: rebuilt.contextLimited,
    };
  };
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
    recoverOverflow,
    compactionCheck: model.compactionCheck,
  };
}

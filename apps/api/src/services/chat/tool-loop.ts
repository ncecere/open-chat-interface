import {
  DEFAULT_MAX_TOOL_STEPS,
  isToolPart,
  MAX_TOOL_STEPS,
  MIN_TOOL_STEPS,
  type ToolLimitReason,
  toolIdOfPart,
} from '@oci/shared';
import {
  InvalidToolInputError,
  type LanguageModelUsage,
  NoSuchToolError,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { logger } from '../../lib/logger.js';
import { allowanceExhausted } from '../quota/index.js';
import { getSetting } from '../settings.js';
import { recordToolCall } from '../tools/audit.js';
import { ToolFailure, type TurnTools, toolDefinition } from '../tools/registry.js';
import { contextBudget, messageCost, textCost } from './context-budget.js';

/** The administrator's step limit, clamped to the allowed range. */
export async function maxToolSteps(): Promise<number> {
  const chat = await getSetting('chat');
  const value = chat.maxToolSteps;
  if (typeof value !== 'number' || !Number.isInteger(value)) return DEFAULT_MAX_TOOL_STEPS;
  return Math.min(MAX_TOOL_STEPS, Math.max(MIN_TOOL_STEPS, value));
}

/** Model steps already taken by a reply being continued after an approval. */
export function stepsTaken(parts: readonly unknown[]): number {
  return parts.filter(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'step-start',
  ).length;
}

/** Text shown for a failed tool step: our own wording, never an internal error. */
export function toolStreamErrorText(error: unknown): string {
  if (error instanceof ToolFailure) return error.message;
  if (InvalidToolInputError.isInstance(error))
    return invalidInputText(error.toolName, issuesOf(error.cause));
  if (typeof error === 'string') {
    // The SDK reports a call it could not parse as its error message.
    const invalid = /^(?:AI_InvalidToolInputError: )?Invalid input for tool ([\w.-]+):/.exec(error);
    if (invalid?.[1]) return invalidInputText(invalid[1], issuesInText(error));
    return 'This tool is not available in this conversation.';
  }
  if (NoSuchToolError.isInstance(error)) return 'This tool is not available in this conversation.';
  return 'An error occurred.';
}

type Issue = { path?: unknown[]; message?: string };

/**
 * Which fields were wrong, in words a model can correct from. Models trained
 * with other tools sometimes send their own arguments (an id and cursor to
 * open a result, say) instead of the schema's.
 */
function invalidInputText(toolName: string, issues: Issue[]): string {
  const detail = issues.length
    ? `${issues
        .slice(0, 3)
        .map((issue) =>
          issue.path?.length
            ? `${issue.path.join('.')}: ${issue.message ?? 'invalid'}`
            : (issue.message ?? 'invalid'),
        )
        .join('; ')}.`
    : 'check the required fields and try again.';
  return `The input for ${toolName} was not valid: ${detail}`;
}

function issuesOf(cause: unknown): Issue[] {
  for (let current = cause, depth = 0; current && depth < 4; depth++) {
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues)) return issues as Issue[];
    current = (current as { cause?: unknown }).cause;
  }
  return [];
}

/** Issues from the SDK's message, which ends "Error message: [ …issues as JSON… ]". */
function issuesInText(message: string): Issue[] {
  const start = message.indexOf('Error message: [');
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(message.slice(start + 'Error message: '.length));
    return Array.isArray(parsed) ? (parsed as Issue[]) : [];
  } catch {
    return [];
  }
}

type Usage = Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'>;

/**
 * One reply's tool loop: the stop conditions (step limit, allowance, context),
 * the per-step usage tally that survives a stop, and the stream decoration that
 * turns search results into sources and records denied and refused calls.
 */
export function createToolLoop(options: {
  tools: TurnTools;
  maxSteps: number;
  /** Steps already taken by this reply before an approval. */
  previousSteps: number;
  user: { id: string; role: Parameters<typeof allowanceExhausted>[0]['role'] };
  modelSlug: string;
  runId: string;
  messageCount: number;
  threadId: string;
  messageId: string;
  /** Model limits and the assembled input, for the context check. */
  resolved: Parameters<typeof contextBudget>[0];
  system: string;
  uiMessages: UIMessage[];
}) {
  const totals = { inputTokens: 0, outputTokens: 0, steps: 0, complete: true };
  let limit: ToolLimitReason | null = null;
  const stepLimit = Math.max(1, options.maxSteps - options.previousSteps);
  const budget = contextBudget(options.resolved);
  let contextUnits = options.uiMessages.reduce(
    (sum, message) => sum + messageCost(message).units,
    textCost(options.system).units,
  );

  const onStepFinish = (
    step: Pick<StepResult<ToolSet>, 'usage' | 'text' | 'toolCalls' | 'toolResults'>,
  ) => {
    totals.steps++;
    if (step.usage.inputTokens == null || step.usage.outputTokens == null) totals.complete = false;
    totals.inputTokens += step.usage.inputTokens ?? 0;
    totals.outputTokens += step.usage.outputTokens ?? 0;
    contextUnits +=
      textCost(step.text).units +
      textCost(
        JSON.stringify([
          step.toolCalls.map((call) => call.input),
          step.toolResults.map((result) => result.output),
        ]),
      ).units;
  };

  /**
   * After the last step that may use tools, one more step runs with the tools
   * withdrawn, so a reply that reaches the limit still ends with an answer
   * built from what it found rather than stopping mid-search.
   */
  const prepareStep: PrepareStepFunction<ToolSet> = ({ stepNumber }) => {
    if (stepNumber < stepLimit) return undefined;
    limit = 'steps';
    return { activeTools: [], toolChoice: 'none' };
  };

  const stopWhen: StopCondition<ToolSet> = async ({ steps }) => {
    // The answering step has no tools; this only guards against a provider
    // that calls one anyway.
    if (steps.length > stepLimit) {
      limit = 'steps';
      return true;
    }
    if (contextUnits > budget.units) {
      limit = 'context';
      return true;
    }
    try {
      if (
        await allowanceExhausted({
          userId: options.user.id,
          role: options.user.role,
          modelSlug: options.modelSlug,
          runId: options.runId,
          tokensIn: totals.inputTokens,
          tokensOut: totals.outputTokens,
          messageCount: options.messageCount,
        })
      ) {
        limit = 'allowance';
        return true;
      }
    } catch (error) {
      // Fail closed: an allowance that cannot be checked is not spent on.
      logger.error({ error, runId: options.runId }, 'Could not check allowance between steps');
      limit = 'allowance';
      return true;
    }
    return false;
  };

  /**
   * Usage to settle. A finished reply reports the SDK's total across steps; a
   * reply stopped mid-loop reports its finished steps as a lower bound.
   */
  const settlement = (total: Usage | undefined, finished: boolean) => {
    if (finished && total?.inputTokens != null && total.outputTokens != null)
      return { inputTokens: total.inputTokens, outputTokens: total.outputTokens };
    if (totals.steps === 0) return null;
    return {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      partial: !finished || !totals.complete,
    };
  };

  return {
    stopWhen,
    prepareStep,
    onStepFinish,
    settlement,
    get limit() {
      return limit;
    },
    stepLimit: options.maxSteps,
    decorate: (existing: readonly unknown[], refused: ReadonlySet<string> = new Set()) =>
      decorateToolStream({ ...options, existing, refused, limit: () => limit }),
  };
}

/**
 * Adds a source for every new link in a finished tool result (web search
 * results, connector resource links), records denied
 * and refused calls (executed calls are recorded by the registry), and ends a
 * reply that hit a limit with a visible note before `finish`.
 */
function decorateToolStream(options: {
  tools: TurnTools;
  maxSteps: number;
  user: { id: string };
  threadId: string;
  messageId: string;
  existing: readonly unknown[];
  /** Approved calls the server refused to run; their denial is recorded as refused. */
  refused: ReadonlySet<string>;
  limit: () => ToolLimitReason | null;
}) {
  const toolNames = new Map<string, string>();
  const seen = new Set<string>();
  let sourceIndex = 0;
  for (const part of options.existing) {
    if (isToolPart(part)) toolNames.set(part.toolCallId, toolIdOfPart(part));
    const candidate = part as { type?: unknown; url?: unknown };
    if (candidate?.type === 'source-url' && typeof candidate.url === 'string') {
      seen.add(candidate.url);
      sourceIndex++;
    }
  }
  const audit = (toolCallId: string, outcome: 'denied' | 'refused' | 'error') => {
    const toolId = toolNames.get(toolCallId) ?? 'unknown';
    const definition = toolDefinition(options.tools, toolId);
    void recordToolCall({
      userId: options.user.id,
      toolId,
      kind: definition?.kind ?? null,
      threadId: options.threadId,
      messageId: options.messageId,
      outcome,
      approvalRequired: definition?.kind === 'write',
      // The person approved a refused call; the server would not run it.
      approval: options.refused.has(toolCallId)
        ? 'approved'
        : outcome === 'denied'
          ? 'denied'
          : null,
      durationMs: null,
      resultBytes: null,
    });
  };
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === 'finish') {
        const reason = options.limit();
        if (reason)
          controller.enqueue({
            type: 'data-tool-limit',
            data: { reason, steps: options.maxSteps },
          });
      }
      controller.enqueue(chunk);
      if (
        (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') &&
        !toolNames.has(chunk.toolCallId)
      )
        toolNames.set(chunk.toolCallId, chunk.toolName);
      if (chunk.type === 'tool-input-error') {
        toolNames.set(chunk.toolCallId, chunk.toolName);
        // A call to a tool outside this turn's set is refused, never run; a
        // known tool with invalid input fails without running.
        audit(
          chunk.toolCallId,
          toolDefinition(options.tools, chunk.toolName) ? 'error' : 'refused',
        );
      }
      if (chunk.type === 'tool-output-denied')
        audit(chunk.toolCallId, options.refused.has(chunk.toolCallId) ? 'refused' : 'denied');
      if (chunk.type === 'tool-output-available' && !chunk.preliminary) {
        const definition = toolDefinition(options.tools, toolNames.get(chunk.toolCallId) ?? '');
        for (const source of definition?.sources?.(chunk.output) ?? []) {
          if (seen.has(source.url)) continue;
          seen.add(source.url);
          controller.enqueue({
            type: 'source-url',
            sourceId: `search-${++sourceIndex}`,
            url: source.url,
            title: source.title,
          });
        }
      }
    },
  });
}

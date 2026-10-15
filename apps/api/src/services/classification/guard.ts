import {
  type ClassificationBlockPoint,
  type ClassificationMode,
  type ClassificationPoint,
  type ClassificationService,
  type DataClassificationPartData,
  ERROR_CODES,
  REMEMBER_TOOL_ID,
  type UserRole,
} from '@oci/shared';
import { AppError } from '../../lib/errors.js';
import { observeClassificationDecision } from '../observability/events.js';
import type { ToolCaller, ToolDefinition } from '../tools/types.js';
import { recordDecision } from './audit.js';
import { classificationSettings } from './config.js';
import {
  approvedForModel,
  type Decision,
  decide,
  loadClasses,
  type ResolvedClass,
  resolveClassification,
} from './resolve.js';
import { classIdsOfConnectors, connectorClassIds, recordConnectorUse } from './store.js';
import { modelStatuses } from './view.js';

/**
 * The enforcement points' interface to classification (SPEC-data-classification.md,
 * "Enforcement points"). `resolve.ts` decides; this file acts on it: it counts
 * and audits the decision, and refuses in the way each place can: an error
 * body for a send, an approval, a compaction and a share link; a withheld tool
 * or service for the places the person never asked for directly.
 */

/** The classes a turn carries and the mode they were read under, kept for the turn's later gates. */
export interface TurnClassification {
  mode: ClassificationMode;
  classes: ResolvedClass[];
  /** Set when `warn` let the turn through: what `block` would have refused, for the reply's notice. */
  warning?: DataClassificationPartData;
}

/** What a turn with no classification looks like (mode `off`): nothing carried. */
export const NO_CLASSIFICATION: TurnClassification = { mode: 'off', classes: [] };

export const toTurnClassification = (
  decision: Decision,
  warning?: { point: ClassificationPoint; model: string },
): TurnClassification => ({
  mode: decision.mode,
  classes: decision.classes,
  ...(decision.outcome === 'warn' &&
    warning && {
      warning: {
        mode: 'warn' as const,
        point: warning.point,
        model: warning.model,
        missing: decision.missing.map((entry) => entry.name),
      },
    }),
});

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function blockedMessage(
  point: ClassificationBlockPoint,
  model: string | undefined,
  missing: readonly ResolvedClass[],
  approvedAny: boolean,
): string {
  const names = listNames(missing.map((entry) => entry.name));
  const them = missing.length === 1 ? 'it' : 'them';
  if (point === 'share')
    return `This conversation cannot be shared. It carries ${names}, and a share link is open to anyone who has it.`;
  const choose = approvedAny
    ? `Choose a model that is approved for ${them}.`
    : `No model is approved for ${them} yet. Ask an administrator.`;
  const lead =
    point === 'send'
      ? 'Your message was not sent.'
      : point === 'approval'
        ? 'The reply cannot continue.'
        : 'The conversation was not summarised.';
  return `${lead} ${model} is not approved for ${names}, which this conversation carries. ${choose}`;
}

interface ModelGate {
  user: { id: string; role: UserRole };
  threadId: string;
  model: { slug: string; displayName: string };
  point: Extract<ClassificationBlockPoint, 'send' | 'approval' | 'compaction'>;
}

/**
 * May this conversation go to this model? Throws `DATA_CLASS_BLOCKED` (403)
 * when it may not, naming what is missing and which models would do. In
 * `warn` it returns the decision (the caller notes it on the reply).
 */
export async function guardModel(gate: ModelGate): Promise<Decision> {
  const decision = await resolveClassification({
    threadId: gate.threadId,
    destination: { kind: 'model', slug: gate.model.slug },
  });
  await recordDecision(decision, {
    userId: gate.user.id,
    point: gate.point,
    destination: 'model',
    modelSlug: gate.model.slug,
    threadId: gate.threadId,
  });
  if (decision.outcome !== 'block') return decision;
  const approvedModels = (await modelStatuses(gate.user.role, decision.classes, 'block'))
    .filter((candidate) => candidate.status === 'ok')
    .map(({ slug, displayName }) => ({ slug, displayName }));
  throw new AppError(
    ERROR_CODES.DATA_CLASS_BLOCKED,
    blockedMessage(gate.point, gate.model.displayName, decision.missing, approvedModels.length > 0),
    403,
    {
      point: gate.point,
      model: { slug: gate.model.slug, displayName: gate.model.displayName },
      missing: decision.missing.map(({ id, name, reasons }) => ({ id, name, reasons })),
      approvedModels,
    },
  );
}

/** May a share link exist for this conversation? Never approved: `block` refuses, `warn` returns the decision. */
export async function guardShare(userId: string, threadId: string): Promise<Decision> {
  const decision = await resolveClassification({ threadId, destination: { kind: 'share' } });
  await recordDecision(decision, { userId, point: 'share', destination: 'share', threadId });
  if (decision.outcome !== 'block') return decision;
  throw new AppError(
    ERROR_CODES.DATA_CLASS_BLOCKED,
    blockedMessage('share', undefined, decision.missing, false),
    403,
    {
      point: 'share',
      missing: decision.missing.map(({ id, name, reasons }) => ({ id, name, reasons })),
      approvedModels: [],
    },
  );
}

/**
 * Whether an existing share link may be read now. Anonymous: nothing is
 * audited and no class is disclosed (the caller answers 404). Only `block`
 * pauses a link; `warn` serves it.
 */
export async function shareReadable(threadId: string): Promise<boolean> {
  const decision = await resolveClassification({ threadId, destination: { kind: 'share' } });
  if (decision.classes.length > 0)
    observeClassificationDecision('share', decision.outcome === 'block' ? 'blocked' : 'allowed');
  return decision.outcome !== 'block';
}

interface ServiceGate {
  userId: string;
  name: ClassificationService;
  point: Extract<ClassificationPoint, 'web_search' | 'embedding' | 'rerank'>;
  /** For the audit entry. */
  threadId?: string | undefined;
  /** Without `known`, the project whose own labels are judged (file embedding). */
  projectId?: string | undefined;
  /** What the turn already read, so the check costs no query. */
  known?: TurnClassification | undefined;
}

/**
 * May what this conversation (or project) carries go to an outside service?
 * False means skip the call and say so; true allows (and, in `warn`, audits
 * what `block` would have refused).
 */
export async function guardService(gate: ServiceGate): Promise<boolean> {
  const decision = gate.known
    ? decide(
        gate.known.mode,
        gate.known.classes,
        new Set((await classificationSettings()).services[gate.name]),
      )
    : await resolveClassification({
        projectId: gate.projectId,
        destination: { kind: 'service', name: gate.name },
      });
  await recordDecision(decision, {
    userId: gate.userId,
    point: gate.point,
    destination: gate.name,
    threadId: gate.threadId,
    projectId: gate.projectId,
  });
  return decision.outcome !== 'block';
}

/** Memory notes outlive the conversation: nothing is written from one that carries a class. */
const MEMORY_WRITE_TOOLS = new Set<string>([REMEMBER_TOOL_ID]);

/**
 * Offer layer: the tools the model is shown. A tool the model is not allowed
 * to use for this conversation is never offered, so it neither calls it nor
 * learns that it exists.
 *
 * - a connector tool, in `block`: only if every class its connector carries is
 *   approved for the model (what the result would add to the conversation);
 * - `web_search`, in `block`: only if everything the conversation carries is
 *   approved for web search;
 * - `remember`, in `warn` and `block`: not in a conversation with any class.
 */
export async function offerTools(
  definitions: ToolDefinition[],
  turn: { classification: TurnClassification; modelSlug: string },
): Promise<ToolDefinition[]> {
  const { mode, classes } = turn.classification;
  if (mode === 'off') return definitions;
  const connectors = [
    ...new Set(definitions.flatMap((definition) => definition.connector?.id ?? [])),
  ];
  const [approved, carried, settings] = await Promise.all([
    mode === 'block' && connectors.length ? approvedForModel(turn.modelSlug) : new Set<string>(),
    mode === 'block' ? connectorClassIds(connectors) : new Map<string, string[]>(),
    classificationSettings(),
  ]);
  return definitions.filter((definition) => {
    if (MEMORY_WRITE_TOOLS.has(definition.id)) return classes.length === 0;
    if (mode !== 'block') return true;
    if (definition.connector)
      return (carried.get(definition.connector.id) ?? []).every((id) => approved.has(id));
    if (definition.id === 'web_search')
      return classes.every((entry) => settings.services.webSearch.includes(entry.id));
    return true;
  });
}

/**
 * Execute layer: judged again when the call is about to run, with the labels
 * as they are now (they may have changed since the tool was offered) and, for
 * a connector tool, as if its connector's classes had already entered the
 * conversation. Returns `refused` without running anything; on `run` for a
 * connector tool the use is already recorded, so a crash after the call still
 * leaves the label. The use is recorded in every mode.
 */
export async function guardToolRun(
  definition: ToolDefinition,
  caller: ToolCaller,
): Promise<'run' | 'refused'> {
  const connectorId = definition.connector?.id;
  const { mode } = await classificationSettings();
  if (mode === 'off') {
    if (connectorId) await recordConnectorUse(caller.threadId, connectorId);
    return 'run';
  }
  const context = {
    userId: caller.userId,
    point: 'tool' as const,
    modelSlug: caller.modelSlug,
    toolId: definition.id,
    threadId: caller.threadId,
  };
  if (MEMORY_WRITE_TOOLS.has(definition.id)) {
    const classes = await loadClasses({ threadId: caller.threadId });
    if (classes.length === 0) return 'run';
    // Never a warning: a note could carry the labelled content out of the conversation.
    await recordDecision(
      { mode, outcome: 'block', classes, missing: classes },
      { ...context, destination: 'memory' },
    );
    return 'refused';
  }
  const decision = await resolveClassification({
    threadId: caller.threadId,
    destination:
      definition.id === 'web_search'
        ? { kind: 'service', name: 'webSearch' }
        : { kind: 'model', slug: caller.modelSlug },
    ...(connectorId && { extraClassIds: await classIdsOfConnectors([connectorId]) }),
  });
  await recordDecision(decision, {
    ...context,
    destination: definition.id === 'web_search' ? 'webSearch' : 'model',
  });
  if (decision.outcome === 'block') return 'refused';
  if (connectorId) await recordConnectorUse(caller.threadId, connectorId);
  return 'run';
}

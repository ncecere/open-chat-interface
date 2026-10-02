import { and, eq, schema } from '@oci/db';
import type { ProjectSearchData, UserRole } from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { singleLine } from '../../lib/text.js';
import {
  type ProjectPassage,
  projectSearchSummary,
  renderPassage,
  selectPassages,
} from '../project-search/passages.js';
import {
  indexedChunkCounts,
  openingProjectChunks,
  projectSearchTerms,
  rankProjectChunks,
} from '../project-search/retrieval.js';
import { roleFeatures } from '../role-features.js';
import { getSetting } from '../settings.js';
import {
  type AttachmentCandidate,
  attachmentCost,
  inspectProjectFiles,
  type ModelAttachment,
  withAttachmentContext,
} from './attachment-context.js';
import { addCost, type ContextCost, emptyCost, fitsContext, textCost } from './context-budget.js';

/**
 * What a conversation's project contributes to a turn: its instructions (in
 * the system prompt) and its files (as model-only context parts). Nothing here
 * is ever written to the stored conversation.
 */
type ProjectContext = {
  id: string;
  userId: string;
  name: string;
  instructions: string;
  /** Candidates only; payloads are loaded after budget selection. */
  files: AttachmentCandidate[];
};

/**
 * At most this share of the model's input budget goes to passages when a
 * project's files are too large to include whole, so the recent conversation
 * keeps room too. Whole files may still use all the room left after the
 * required context, as in v0.7.
 */
export const PROJECT_PASSAGE_SHARE = 0.5;
/** Ranked candidates fetched per turn; far more than any budget can take. */
const PASSAGE_CANDIDATES = 160;

/**
 * Loads the project of a conversation, or null when there is nothing to add.
 *
 * With the role's `projects` feature off, the conversation carries on as an
 * ordinary one: the project row is kept but contributes nothing. Files also
 * need attachments to be allowed for the role and the instance, like any
 * other file reaching a model; without that only the instructions apply.
 */
export async function loadProjectContext(
  projectId: string | null,
  user: { id: string; role: UserRole },
): Promise<ProjectContext | null> {
  if (!projectId) return null;
  const own = await roleFeatures(user.role);
  if (!own.projects) return null;
  const [project] = await db
    .select({ name: schema.project.name, instructions: schema.project.instructions })
    .from(schema.project)
    .where(and(eq(schema.project.id, projectId), eq(schema.project.userId, user.id)))
    .limit(1);
  if (!project) return null;

  let files: AttachmentCandidate[] = [];
  if (own.attachments && (await getSetting('features')).attachments) {
    files = await inspectProjectFiles(projectId, user.id);
  }
  return { id: projectId, userId: user.id, ...project, files };
}

/**
 * Project instructions go after the instance prompt and the person's own
 * customisation, clearly delimited so the model can tell where they start
 * and stop, and subordinate to what came before.
 */
export function withProjectInstructions(system: string, project: ProjectContext | null): string {
  const instructions = project?.instructions.trim();
  if (!project || !instructions) return system;
  return [
    system,
    [
      `This conversation belongs to the project "${singleLine(project.name)}". Follow the project's instructions below unless they conflict with the instructions above.`,
      '<project_instructions>',
      instructions,
      '</project_instructions>',
    ].join('\n'),
  ].join('\n\n');
}

function projectFilesHeader(name: string): string {
  return `Files from the project "${singleLine(name)}". They are reference material for every conversation in the project, not files attached to this message.`;
}

function projectPassagesHeader(name: string, mode: ProjectSearchData['mode']): string {
  const chosen =
    mode === 'search'
      ? 'the passages below are the ones that best match the latest message'
      : 'the passages below are the opening passages of each file';
  return `${projectFilesHeader(name)} The files are too long to include in full, so ${chosen}, labelled with their file and passage number. The rest of the files is not shown.`;
}

/** The `data-project-search` part: file names and passage counts, never passage text. */
export type ProjectSearchPart = {
  type: 'data-project-search';
  id: string;
  data: ProjectSearchData;
};

type ProjectFileSelection = {
  /** Files included whole. */
  files: AttachmentCandidate[];
  /** Searched passages, already rendered, when the files were too large to include whole. */
  search: { header: string; passages: string[] } | null;
  cost: ContextCost;
  /** Files left out entirely, which marks the reply as context-limited. */
  omitted: number;
  searchPart: ProjectSearchPart | null;
};

const noProjectFiles = (omitted = 0): ProjectFileSelection => ({
  files: [],
  search: null,
  cost: emptyCost(),
  omitted,
  searchPart: null,
});

/** Whole files, oldest first, skipping any that do not fit after `cost`. */
function fitWholeFiles(
  candidates: AttachmentCandidate[],
  start: ContextCost,
  required: ContextCost,
  budget: ContextCost,
  supportsVision: boolean,
) {
  let cost = start;
  const files: AttachmentCandidate[] = [];
  for (const file of candidates) {
    const next = addCost(cost, attachmentCost(file, supportsVision));
    if (!fitsContext(addCost(required, next), budget)) continue;
    cost = next;
    files.push(file);
  }
  return { files, cost };
}

/**
 * Chooses what the project's files contribute after everything a turn requires
 * (system prompt, the latest message and its own files); history is then
 * trimmed to whatever room remains. The result never exceeds the budget.
 *
 * 1. If every file fits whole, they are all included whole, as in v0.7.
 * 2. Otherwise the indexed files are searched with the latest message and the
 *    best passages are included, up to `PROJECT_PASSAGE_SHARE` of the budget
 *    (or what room remains, if less). Files with nothing indexed (not yet
 *    indexed, or no text such as images) are still included whole, oldest
 *    first, when they fit; one that does not fit is skipped, never truncated,
 *    and the reply is marked context-limited.
 */
export async function selectProjectFiles(
  project: ProjectContext | null,
  required: ContextCost,
  budget: ContextCost,
  supportsVision: boolean,
  latestText: string,
): Promise<ProjectFileSelection> {
  if (!project || project.files.length === 0) return noProjectFiles();
  const whole = fitWholeFiles(
    project.files,
    textCost(projectFilesHeader(project.name)),
    required,
    budget,
    supportsVision,
  );
  const v07 = (): ProjectFileSelection =>
    whole.files.length === 0
      ? noProjectFiles(project.files.length)
      : { ...noProjectFiles(project.files.length - whole.files.length), ...whole };
  if (whole.files.length === project.files.length) return v07();

  const counts = await indexedChunkCounts(project.files.map((file) => file.id));
  const searchable = project.files.filter((file) => (counts.get(file.id) ?? 0) > 0);
  if (searchable.length === 0) return v07();
  const others = project.files.filter((file) => (counts.get(file.id) ?? 0) === 0);

  const scope = {
    userId: project.userId,
    projectId: project.id,
    fileIds: searchable.map((file) => file.id),
  };
  const operands = await projectSearchTerms(latestText);
  let mode: ProjectSearchData['mode'] = 'search';
  let candidates = await rankProjectChunks(scope, operands, PASSAGE_CANDIDATES);
  if (candidates.length === 0) {
    mode = 'opening';
    candidates = await openingProjectChunks(scope, PASSAGE_CANDIDATES);
  }

  // The longer header is costed up front so the passages' share stays exact.
  const header = projectPassagesHeader(project.name, mode);
  const kept = fitWholeFiles(others, textCost(header), required, budget, supportsVision);
  const room = budget.units - required.units - kept.cost.units;
  const share = Math.min(room, Math.floor(budget.units * PROJECT_PASSAGE_SHARE));
  const passages: ProjectPassage[] =
    share > 0 ? selectPassages(candidates, scope.fileIds, share) : [];
  const omitted = others.length - kept.files.length;
  if (passages.length === 0) {
    // Nothing to search fits: fall back to whatever whole files fit.
    return v07();
  }
  const rendered = passages.map(renderPassage);
  const cost = rendered.reduce((sum, text) => addCost(sum, textCost(text)), kept.cost);
  return {
    files: kept.files,
    search: { header, passages: rendered },
    cost,
    omitted,
    searchPart: {
      type: 'data-project-search',
      id: `project-search-${crypto.randomUUID()}`,
      data: projectSearchSummary(passages, mode),
    },
  };
}

/**
 * Prepends the project files to the first user message in context, through
 * the same rendering as message attachments (extracted text, or image bytes
 * for vision models), followed by any searched passages.
 */
export function withProjectFiles(
  messages: UIMessage[],
  project: ProjectContext | null,
  files: ModelAttachment[],
  supportsVision: boolean,
  search: ProjectFileSelection['search'] = null,
): UIMessage[] {
  if (!project || (files.length === 0 && !search)) return messages;
  const index = messages.findIndex((message) => message.role === 'user');
  if (index < 0) return messages;
  const context = withAttachmentContext(
    {
      id: 'project-files',
      role: 'user',
      parts: [{ type: 'text', text: search?.header ?? projectFilesHeader(project.name) }],
    },
    files,
    supportsVision,
  );
  const passages: UIMessage['parts'] = (search?.passages ?? []).map((text) => ({
    type: 'text',
    text,
  }));
  return messages.map((message, position) =>
    position === index
      ? { ...message, parts: [...context.parts, ...passages, ...message.parts] }
      : message,
  );
}

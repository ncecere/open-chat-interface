import { and, eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
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
  name: string;
  instructions: string;
  /** Candidates only; payloads are loaded after budget selection. */
  files: AttachmentCandidate[];
};

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
  return { ...project, files };
}

function displayName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
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
      `This conversation belongs to the project "${displayName(project.name)}". Follow the project's instructions below unless they conflict with the instructions above.`,
      '<project_instructions>',
      instructions,
      '</project_instructions>',
    ].join('\n'),
  ].join('\n\n');
}

function projectFilesHeader(name: string): string {
  return `Files from the project "${displayName(name)}". They are reference material for every conversation in the project, not files attached to this message.`;
}

/**
 * Chooses the project files that fit after everything a turn requires (system
 * prompt, the latest message and its own files). Files are tried oldest first
 * and a file that does not fit is skipped, never truncated; history is then
 * trimmed to whatever room remains. The result never exceeds the budget.
 */
export function selectProjectFiles(
  project: ProjectContext | null,
  required: ContextCost,
  budget: ContextCost,
  supportsVision: boolean,
): { files: AttachmentCandidate[]; cost: ContextCost; omitted: number } {
  if (!project || project.files.length === 0) {
    return { files: [], cost: emptyCost(), omitted: 0 };
  }
  let cost = textCost(projectFilesHeader(project.name));
  const files: AttachmentCandidate[] = [];
  for (const file of project.files) {
    const next = addCost(cost, attachmentCost(file, supportsVision));
    if (!fitsContext(addCost(required, next), budget)) continue;
    cost = next;
    files.push(file);
  }
  if (files.length === 0) {
    return { files: [], cost: emptyCost(), omitted: project.files.length };
  }
  return { files, cost, omitted: project.files.length - files.length };
}

/**
 * Prepends the project files to the first user message in context, through
 * the same rendering as message attachments (extracted text, or image bytes
 * for vision models).
 */
export function withProjectFiles(
  messages: UIMessage[],
  project: ProjectContext | null,
  files: ModelAttachment[],
  supportsVision: boolean,
): UIMessage[] {
  if (!project || files.length === 0) return messages;
  const index = messages.findIndex((message) => message.role === 'user');
  if (index < 0) return messages;
  const context = withAttachmentContext(
    {
      id: 'project-files',
      role: 'user',
      parts: [{ type: 'text', text: projectFilesHeader(project.name) }],
    },
    files,
    supportsVision,
  );
  return messages.map((message, position) =>
    position === index ? { ...message, parts: [...context.parts, ...message.parts] } : message,
  );
}

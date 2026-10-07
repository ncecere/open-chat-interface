import type { UserRole } from '@oci/shared';
import { logger } from '../../lib/logger.js';
import { roleFeatures } from '../role-features.js';
import { describeArtifact } from '../tools/artifacts.js';
import { editedArtifactsForPrompt } from './queries.js';

/**
 * What the model is told when the person has edited an artifact by hand
 * (#366). The model sees an artifact only through its own earlier
 * create_artifact and update_artifact calls, which hold the versions it wrote:
 * asked later about a line the person added, it answered that the document did
 * not mention it. So the latest saved content of each hand-edited artifact is
 * added to the prompt, within a fixed share of the input budget (like memories,
 * so a long document cannot crowd out the conversation on a small model).
 */
const ARTIFACT_BUDGET_SHARE = 0.2;
const MAX_ARTIFACT_PROMPT_UNITS = 64 * 1024;

function artifactBudgetUnits(inputUnits: number): number {
  return Math.max(
    0,
    Math.min(MAX_ARTIFACT_PROMPT_UNITS, Math.floor(inputUnits * ARTIFACT_BUDGET_SHARE)),
  );
}

const HEADER = [
  '<edited-artifacts>',
  'The person edited these artifacts by hand after you wrote them. Your earlier create_artifact and update_artifact calls show older versions: the content below is the latest saved version of each, and it is what questions about the artifact and update_artifact edits refer to.',
].join('\n');
const CLOSE = '</edited-artifacts>';

/** An artifact's text may not close its tags early. */
const neutralize = (content: string) =>
  content.replace(/<(\/?)(artifact|edited-artifacts)\b/gi, '<\u200b$1$2');

/** The first `units` bytes of `text`, never ending inside a character. */
function head(text: string, units: number): string {
  let used = 0;
  let out = '';
  for (const character of text) {
    used += Buffer.byteLength(character, 'utf8');
    if (used > units) break;
    out += character;
  }
  return out;
}

interface EditedArtifact {
  id: string;
  title: string;
  kind: Parameters<typeof describeArtifact>[0]['kind'];
  language?: string | null;
  currentVersion: number;
  content: string;
}

/**
 * Whole artifacts, newest change first, while they fit in `units` bytes; the
 * first that does not is cut with a note saying so, and the rest are left out
 * (their titles are still listed in the system prompt).
 */
export function editedArtifactsSection(
  artifacts: readonly EditedArtifact[],
  units: number,
): string {
  if (artifacts.length === 0) return '';
  let used = Buffer.byteLength(`${HEADER}\n${CLOSE}`, 'utf8');
  const blocks: string[] = [];
  for (const artifact of artifacts) {
    // The same words the system prompt lists the artifact by, then its text.
    const label = neutralize(`${artifact.id} ${describeArtifact(artifact)}`).replace(/\s+/g, ' ');
    const open = `${label}:\n<artifact>`;
    const frame = Buffer.byteLength(`${open}\n\n</artifact>`, 'utf8') + 1;
    const content = neutralize(artifact.content);
    const room = units - used - frame;
    if (room <= 0) break;
    if (Buffer.byteLength(content, 'utf8') <= room) {
      blocks.push(`${open}\n${content}\n</artifact>`);
      used += frame + Buffer.byteLength(content, 'utf8');
      continue;
    }
    const note = '\n[The rest of this artifact is not shown here.]';
    const noteSize = Buffer.byteLength(note, 'utf8');
    if (room <= noteSize) break;
    blocks.push(`${open}\n${head(content, room - noteSize)}${note}\n</artifact>`);
    break;
  }
  if (blocks.length === 0) return '';
  return [HEADER, ...blocks, CLOSE].join('\n');
}

/**
 * The section for one turn, or '' when the role has no artifacts or none was
 * edited by hand. Best effort: a failure leaves it out rather than failing the reply.
 */
export async function loadEditedArtifactsSection(
  turn: { threadId: string; userId: string; role: UserRole },
  inputUnits: number,
): Promise<string> {
  try {
    if (!(await roleFeatures(turn.role)).artifacts) return '';
    return editedArtifactsSection(
      await editedArtifactsForPrompt(turn.threadId, turn.userId),
      artifactBudgetUnits(inputUnits),
    );
  } catch (error) {
    logger.warn(
      { error, threadId: turn.threadId },
      'Could not read edited artifacts for the prompt',
    );
    return '';
  }
}

/** Appends the section to a system prompt. */
export function withEditedArtifacts(system: string, section: string): string {
  if (!section) return system;
  return system ? `${system}\n\n${section}` : section;
}

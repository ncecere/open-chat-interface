import type { SendMessageInput } from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';
import type { AuthenticatedUser } from '../../middleware/context.js';
import {
  guardModel,
  type TurnClassification,
  toTurnClassification,
} from '../classification/guard.js';
import { resolveModelForRole } from '../models.js';
import { assertReasoningEffortSupported } from '../reasoning.js';
import { assertRoleFeature, roleFeatures } from '../role-features.js';
import { assertTemporaryChatAllowed, getOwnedThread } from '../threads.js';
import { resolveTurnTools, type TurnTools } from '../tools/registry.js';
import { assertExcludableProjectFiles } from './project-context.js';

export type TurnContext = {
  user: Pick<AuthenticatedUser, 'id' | 'name' | 'role'>;
  input: SendMessageInput;
  thread: Awaited<ReturnType<typeof getOwnedThread>>;
  resolved: Awaited<ReturnType<typeof resolveModelForRole>>;
  /** Tools offered to the model this turn; empty for models without tool calling. */
  tools: TurnTools;
  /**
   * What the conversation carries (data classification, v0.14): read once at
   * the gate, so the turn's later calls to outside services need no query.
   * Absent reads as nothing carried, mode `off`.
   */
  classification?: TurnClassification;
  /** A new message's patience with a database outage (turn-patience.ts, #326). */
  admission?: TurnAdmission;
};

export type TurnAdmission = {
  /** Steps up to the prompt's saving retry a lost connection until then. */
  deadline: number;
  /** Called as the prompt's transaction begins: the message may be stored from here. */
  onSaving: () => void;
};

/** Validate access and model before claiming; no history or turn writes. */
export async function resolveTurnContext(
  user: TurnContext['user'],
  input: SendMessageInput,
): Promise<TurnContext> {
  const thread = await getOwnedThread(input.threadId, user.id);
  if (input.temporary && !thread.temporary)
    throw validationFailed('Temporary mode must be selected when the thread is created');
  if (thread.temporary) await assertTemporaryChatAllowed(user.role);
  // The composer hides the toggle, but the request is the boundary. The
  // instance-wide switch is checked where the search runs.
  if (input.webSearch) await assertRoleFeature(user.role, 'webSearch');
  const resolved = await resolveModelForRole(input.modelSlug, user.role);
  const { reasoningEfforts } = await roleFeatures(user.role);
  assertReasoningEffortSupported(input.effort, resolved.supportedEfforts, reasoningEfforts);
  if (!input.messages[0]) throw validationFailed('A user message is required');
  // Validated before the turn is claimed, so a bad id never leaves a message behind.
  await assertExcludableProjectFiles(thread.projectId, user.id, input.excludedProjectFileIds ?? []);
  // Data classification: may this conversation go to this model? Refused here,
  // before a run is acquired or anything stored, so a block leaves no message
  // behind and the text goes back to the box (X-OCI-Message-Saved: no).
  const guarded = await guardModel({
    user,
    threadId: thread.id,
    model: { slug: resolved.slug, displayName: resolved.displayName ?? resolved.slug },
    point: 'send',
  });
  const classification = toTurnClassification(guarded, { point: 'send', model: resolved.slug });
  const tools = await resolveTurnTools({
    role: user.role,
    userId: user.id,
    capabilities: resolved.capabilities,
    webSearch: input.webSearch,
    temporary: thread.temporary,
    classification: { modelSlug: resolved.slug, classes: classification },
  });
  return { user, input, thread, resolved, tools, classification };
}

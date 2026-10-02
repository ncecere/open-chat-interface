import type { SendMessageInput } from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';
import type { AuthenticatedUser } from '../../middleware/context.js';
import { resolveModelForRole } from '../models.js';
import { assertReasoningEffortSupported } from '../reasoning.js';
import { assertRoleFeature, roleFeatures } from '../role-features.js';
import { assertTemporaryChatAllowed, getOwnedThread } from '../threads.js';
import { resolveTurnTools, type TurnTools } from '../tools/registry.js';

export type TurnContext = {
  user: Pick<AuthenticatedUser, 'id' | 'name' | 'role'>;
  input: SendMessageInput;
  thread: Awaited<ReturnType<typeof getOwnedThread>>;
  resolved: Awaited<ReturnType<typeof resolveModelForRole>>;
  /** Tools offered to the model this turn; empty for models without tool calling. */
  tools: TurnTools;
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
  const tools = await resolveTurnTools({
    role: user.role,
    userId: user.id,
    capabilities: resolved.capabilities,
    webSearch: input.webSearch,
  });
  return { user, input, thread, resolved, tools };
}

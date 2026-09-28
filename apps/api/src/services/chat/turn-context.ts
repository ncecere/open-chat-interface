import type { SendMessageInput } from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';
import type { AuthenticatedUser } from '../../middleware/context.js';
import { resolveModelForRole } from '../models.js';
import { assertReasoningEffortSupported } from '../reasoning.js';
import { assertTemporaryChatAllowed, getOwnedThread } from '../threads.js';

export type TurnContext = {
  user: Pick<AuthenticatedUser, 'id' | 'name' | 'role'>;
  input: SendMessageInput;
  thread: Awaited<ReturnType<typeof getOwnedThread>>;
  resolved: Awaited<ReturnType<typeof resolveModelForRole>>;
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
  const resolved = await resolveModelForRole(input.modelSlug, user.role);
  assertReasoningEffortSupported(input.effort, resolved.supportedEfforts);
  if (!input.messages[0]) throw validationFailed('A user message is required');
  return { user, input, thread, resolved };
}

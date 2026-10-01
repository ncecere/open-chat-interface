import type { SendMessageInput } from '@oci/shared';
import { prepareTurn } from './prepare-turn.js';
import { failRunSetup } from './run-cleanup.js';
import { acquireRun } from './run-lifecycle.js';
import { resolveTurnContext, type TurnContext } from './turn-context.js';

/** Single owner of the admission → preparation failure boundary. */
export async function setupTurn(user: TurnContext['user'], input: SendMessageInput) {
  const context = await resolveTurnContext(user, input);
  const run = await acquireRun(context);
  try {
    return { turn: await prepareTurn(context, run), run };
  } catch (error) {
    await failRunSetup(run);
    throw error;
  }
}

import type { SendMessageInput } from '@oci/shared';
import { prepareTurn } from './prepare-turn.js';
import { failRunSetup } from './run-cleanup.js';
import { acquireRun } from './run-lifecycle.js';
import { resolveTurnContext, type TurnAdmission, type TurnContext } from './turn-context.js';
import { retryTurnStep } from './turn-patience.js';

/** Single owner of the admission → preparation failure boundary. */
export async function setupTurn(
  user: TurnContext['user'],
  input: SendMessageInput,
  admission?: TurnAdmission,
) {
  // Reads only: run again while the database is unreachable (#326).
  const context: TurnContext = {
    ...(await retryTurnStep(admission?.deadline, 'turn context', () =>
      resolveTurnContext(user, input),
    )),
    admission,
  };
  const run = await acquireRun(context);
  try {
    return { turn: await prepareTurn(context, run), run };
  } catch (error) {
    await failRunSetup(run);
    throw error;
  }
}

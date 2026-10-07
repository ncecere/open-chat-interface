/**
 * The acceptable use policy, refused by the server (#367).
 *
 * The browser asks before the application is shown (OnboardingGate), but the
 * server now refuses a write from a person who has not accepted the published
 * version too: `403 POLICY_ACCEPTANCE_REQUIRED`. It can reach a tab that was
 * already open when a new version was published (the gate's answer is kept
 * for five minutes), so any such refusal is reported here and the gate looks
 * again, which puts the acceptance page in front of the application.
 */

export const POLICY_ACCEPTANCE_REQUIRED = 'POLICY_ACCEPTANCE_REQUIRED';

const listeners = new Set<() => void>();

/** A request was refused because the policy in force has not been accepted. */
export function notePolicyRequired(): void {
  for (const listener of listeners) listener();
}

/** Called each time the server refuses a request for want of an acceptance. */
export function onPolicyRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * For a request made with `fetch` directly (an upload, the chat stream): looks
 * at a failed response, without consuming it, and reports a policy refusal.
 */
export async function notePolicyRequiredResponse(response: Response): Promise<void> {
  if (response.status !== 403) return;
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    if (body?.error?.code === POLICY_ACCEPTANCE_REQUIRED) notePolicyRequired();
  } catch {
    // Not an API error body: not ours.
  }
}

/**
 * Two-step verification required of this session, refused by the server (#399).
 *
 * The browser sends a limited person to the setup page as soon as `GET /api/me`
 * says `mfa.limited` (MfaGate, and the settings and administration guards), but
 * the requirement can start while a tab is open: a role is added with no grace
 * and the next request of an already signed-in session answers
 * `403 MFA_ENROLMENT_REQUIRED`. Any such refusal is reported here, the same way
 * `POLICY_ACCEPTANCE_REQUIRED` is (policy-required.ts), and the gate looks at
 * `/api/me` again and the router moves the person to the setup page.
 */

export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED';

const listeners = new Set<() => void>();

/** A request was refused because this session is limited until a second step is set up. */
export function noteMfaRequired(): void {
  for (const listener of listeners) listener();
}

/** Called each time the server refuses a request for want of a second step. */
export function onMfaRequired(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * For a request made with `fetch` directly (an upload, the chat stream): looks
 * at a failed response, without consuming it, and reports a refusal.
 */
export async function noteMfaRequiredResponse(response: Response): Promise<void> {
  if (response.status !== 403) return;
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    if (body?.error?.code === MFA_ENROLMENT_REQUIRED) noteMfaRequired();
  } catch {
    // Not an API error body: not ours.
  }
}

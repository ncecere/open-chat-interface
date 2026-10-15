import { confirmTotpInputSchema, enableTotpInputSchema, mfaReauthInputSchema } from '@oci/shared';
import { Hono } from 'hono';
import { clientIp } from '../lib/client-ip.js';
import { enforceSecondFactorLimit } from '../middleware/auth-rate-limit.js';
import {
  type AppBindings,
  currentUser,
  requireAuth,
  type SessionMfaFacts,
} from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import {
  beginTotp,
  confirmTotp,
  disableTotp,
  regenerateRecoveryCodes,
} from '../services/mfa/enrolment.js';
import { notifyMfaChange } from '../services/mfa/notify.js';
import { mfaStatusFor } from '../services/mfa/state.js';

/**
 * Two-step verification for the signed-in person (Settings → Account, and the
 * setup page a limited person is sent to), v0.14, #399. docs/dev/mfa-api.md has
 * the contract. Everything here is allowed while the session is limited
 * (middleware/mfa-gate.ts): it is how a limited person gets out of being limited.
 *
 * Every response is `Cache-Control: no-store`; the secret and the recovery
 * codes appear only in the response that creates them. Each POST counts wrong
 * passwords and codes against the second-step limit (per session and address,
 * refunded when it works), so the session of somebody else is not an oracle.
 */
export const meMfaRoutes = new Hono<AppBindings>();

meMfaRoutes.use('*', requireAuth);
meMfaRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

function factsOf(c: { get: (key: 'mfa') => SessionMfaFacts | null | undefined }) {
  return c.get('mfa') ?? null;
}

/** The session cookies the plugin set (confirming and disabling swap the session), passed on. */
function forwardCookies(
  c: { header: (name: string, value: string, options?: { append: boolean }) => void },
  cookies: string[],
) {
  for (const cookie of cookies) c.header('set-cookie', cookie, { append: true });
}

meMfaRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json(await mfaStatusFor({ id: user.id, role: user.role }, factsOf(c)));
});

meMfaRoutes.post('/totp', async (c) => {
  const user = currentUser(c);
  const { password } = await parseBody(c, enableTotpInputSchema);
  const refund = await enforceSecondFactorLimit(c);
  const result = await beginTotp(user, c.req.raw.headers, password);
  await refund();
  return c.json(result);
});

meMfaRoutes.post('/totp/confirm', async (c) => {
  const user = currentUser(c);
  const { code } = await parseBody(c, confirmTotpInputSchema);
  const refund = await enforceSecondFactorLimit(c);
  const { body, setCookies } = await confirmTotp(user, c.req.raw.headers, code);
  await refund();
  forwardCookies(c, setCookies);
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.mfa.enabled',
    targetType: 'user',
    targetId: user.id,
    ipAddress: clientIp(c),
    metadata: { method: 'totp', recoveryCodes: body.recoveryCodes.length },
  });
  notifyMfaChange(user, 'enabled');
  return c.json(body);
});

meMfaRoutes.post('/totp/disable', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, mfaReauthInputSchema);
  const refund = await enforceSecondFactorLimit(c);
  const { body, setCookies } = await disableTotp(user, c.req.raw.headers, input);
  await refund();
  forwardCookies(c, setCookies);
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.mfa.disabled',
    targetType: 'user',
    targetId: user.id,
    ipAddress: clientIp(c),
    metadata: { method: 'totp' },
  });
  notifyMfaChange(user, 'disabled');
  return c.json(body);
});

meMfaRoutes.post('/recovery-codes', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, mfaReauthInputSchema);
  const refund = await enforceSecondFactorLimit(c);
  const body = await regenerateRecoveryCodes(user, c.req.raw.headers, input);
  await refund();
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.mfa.recovery_codes.regenerated',
    targetType: 'user',
    targetId: user.id,
    ipAddress: clientIp(c),
    metadata: { count: body.recoveryCodes.length },
  });
  notifyMfaChange(user, 'recovery_codes_regenerated');
  return c.json(body);
});

// @vitest-environment happy-dom
import type { SsoProviderSummary } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SsoProviderList } from '../../src/routes/admin/sso-provider-list';
import { cleanup, renderAdmin } from './admin-test-utils';

/**
 * The enable switch on each SSO provider (#325): its name said what pressing
 * it would do ("Disable Walk Keycloak") while aria-checked said it was on, so
 * a screen reader announced "Disable Walk Keycloak, switch, on". A switch's
 * name stays the same; its state is aria-checked.
 */
const provider = (label: string, enabled: boolean): SsoProviderSummary => ({
  id: label,
  providerId: label.toLowerCase().replace(/\s+/g, '-'),
  label,
  kind: 'oidc',
  enabled,
  jitProvisioning: true,
  trustedForLinking: false,
  allowedDomains: [],
  defaultRole: 'user',
  claimRoleMappings: [],
  requireRoleMatch: false,
  roleRequiredMessage: null,
  claimMappings: {} as SsoProviderSummary['claimMappings'],
  autoRedirect: false,
  issuer: 'https://id.example.edu/realms/walk',
  callbackUrl: 'https://oci.example.edu/api/auth/sso/callback',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

it('names each provider switch the same way, on or off, with its state as aria-checked', async () => {
  ({ root } = await renderAdmin(
    <SsoProviderList
      providers={[provider('Walk Keycloak', true), provider('Campus ID', false)]}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  ));
  const switches = [...document.querySelectorAll('[role="switch"]')].map((element) => [
    element.getAttribute('aria-label'),
    element.getAttribute('aria-checked'),
  ]);
  expect(switches).toEqual([
    ['Enable Walk Keycloak', 'true'],
    ['Enable Campus ID', 'false'],
  ]);
});

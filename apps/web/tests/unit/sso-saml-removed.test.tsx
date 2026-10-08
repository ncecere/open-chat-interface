// @vitest-environment happy-dom
import type { SsoProviderSummary } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SsoProvidersSection } from '../../src/routes/admin/sso';
import {
  button,
  buttonNames,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
} from './admin-test-utils';

/**
 * SAML was removed (#53). The admin page is the real section with a real
 * query client; only the HTTP client is replaced. A provider created while
 * SAML was supported is listed with a notice and only a Delete action, and
 * the add form offers OpenID Connect alone.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const NOTICE =
  'SAML 2.0 is no longer supported. This provider is not offered at sign-in; delete it or replace it with an OpenID Connect provider.';

const provider = (label: string, kind: 'oidc' | 'saml', enabled: boolean): SsoProviderSummary => ({
  id: label,
  providerId: label.toLowerCase().replace(/\s+/g, '-'),
  label,
  kind,
  enabled,
  jitProvisioning: true,
  trustedForLinking: false,
  allowedDomains: [],
  defaultRole: 'user',
  claimRoleMappings: [],
  requireRoleMatch: false,
  roleRequiredMessage: null,
  claimMappings: {},
  autoRedirect: false,
  issuer: 'https://id.example.edu/realms/walk',
  callbackUrl: kind === 'saml' ? null : 'https://oci.example.edu/api/auth/sso/callback/walk',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

let root: Root | undefined;
beforeEach(() => {
  api.get.mockResolvedValue({
    providers: [provider('Campus SAML', 'saml', true), provider('Walk Keycloak', 'oidc', true)],
  });
  api.delete.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.clearAllMocks();
});

it('lists a legacy SAML provider with the notice and only a Delete action', async () => {
  ({ root } = await renderAdmin(<SsoProvidersSection />));
  const text = document.body.textContent ?? '';
  expect(text).toContain(NOTICE);
  expect(text).toContain('Not offered at sign-in');

  const names = buttonNames();
  // Nothing to enable, edit or register for the SAML provider...
  expect(names).not.toContain('Edit Campus SAML');
  expect(document.querySelector('[aria-label="Enable Campus SAML"]')).toBeNull();
  // ...it can only be deleted...
  expect(names).toContain('Delete Campus SAML');
  // ...while the OpenID Connect provider keeps all of its controls.
  expect(names).toContain('Edit Walk Keycloak');
  expect(names).toContain('Delete Walk Keycloak');
  expect(document.querySelector('[aria-label="Enable Walk Keycloak"]')).not.toBeNull();
  // One redirect address to copy: the OpenID Connect provider's.
  expect(names.filter((name) => name.startsWith('Copy '))).toEqual(['Copy Redirect URI']);
  expect(text).not.toContain('Assertion Consumer Service');
  expect(text).not.toContain('SP metadata');
});

it('deletes a legacy SAML provider', async () => {
  ({ root } = await renderAdmin(<SsoProvidersSection />));
  await click(button('Delete Campus SAML'));
  await click(button('Delete provider'));
  expect(api.delete).toHaveBeenCalledWith('/admin/sso/providers/campus-saml');
});

it('describes the section and the add form as OpenID Connect only, with no provider type', async () => {
  api.get.mockResolvedValue({ providers: [] });
  ({ root } = await renderAdmin(<SsoProvidersSection />));
  const section = document.body.textContent ?? '';
  expect(section).toContain('Connect OpenID Connect identity providers');
  expect(section).toContain('Add an OpenID Connect provider');
  expect(section).not.toMatch(/SAML/i);

  await click(findButton('Add provider')!);
  const form = dialog()!;
  expect(form.textContent).toContain('Configure an OpenID Connect identity provider.');
  expect(form.textContent).toContain('OpenID Connect configuration');
  expect(form.textContent).not.toMatch(/SAML/i);
  expect(form.querySelector('#sso-kind')).toBeNull();
  expect(form.textContent).not.toContain('Provider type');
});

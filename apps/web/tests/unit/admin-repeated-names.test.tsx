// @vitest-environment happy-dom
import type { AdminModel } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelScopePicker } from '../../src/components/admin/model-scope-picker';
import { AdminAuditPage } from '../../src/routes/admin/audit';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { ProvidersSection } from '../../src/routes/admin/providers';
import { buttonNames, cleanup, renderAdmin } from './admin-test-utils';

/**
 * Controls repeated on every row name what they act on, as the Edit and
 * Delete buttons beside them already do (#175, #220): a screen reader's list
 * of buttons otherwise reads "Discover models, Discover models, …".
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setColorTheme: vi.fn() }),
}));

const provider = (id: string, label: string) => ({
  id,
  label,
  kind: 'openai',
  enabled: true,
  baseUrl: null,
  credentialHint: 'abcd',
  modelCount: 1,
});

const model = (slug: string, labId: string): AdminModel => ({
  id: slug,
  slug,
  displayName: slug,
  description: null,
  providerId: 'p1',
  providerKind: 'openai',
  providerLabel: 'OpenAI',
  labId,
  upstreamModelId: slug,
  capabilities: [],
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  inputPriceMicros: null,
  outputPriceMicros: null,
  isDefault: false,
  sortOrder: 0,
  enabled: true,
  visibleToRoles: ['admin'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const event = (id: string, action: string, createdAt: string) => ({
  id,
  organizationId: 'org',
  actorUserId: 'admin-1',
  actorEmail: 'admin@example.test',
  action,
  targetType: 'user',
  targetId: 'user-9',
  metadata: { banned: true },
  ipAddress: null,
  createdAt,
});

const shareable = (id: string, role: string, createdAt: string) => ({
  id,
  email: null,
  role,
  expiresAt: null,
  redeemedAt: null,
  redeemedByUserId: null,
  createdAt,
});

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/providers')
      return { providers: [provider('p1', 'Primary OpenAI'), provider('p2', 'Backup OpenAI')] };
    if (path === '/admin/providers/capacity') return { providers: [], queue: null };
    if (path === '/admin/models')
      return { models: [model('gpt-a', 'openai'), model('claude-a', 'anthropic')] };
    if (path === '/admin/audit/actions') return { actions: ['user.update'] };
    if (path.startsWith('/admin/audit?'))
      return {
        entries: [
          event('e1', 'user.update', '2026-10-05T12:00:00.000Z'),
          event('e2', 'user.role.change', '2026-10-05T12:05:00.000Z'),
        ],
        total: 2,
      };
    if (path.startsWith('/admin/views')) return { views: [] };
    if (path === '/admin/invites')
      return {
        invites: [
          shareable('i1', 'user', '2026-10-05T12:00:00.000Z'),
          shareable('i2', 'auditor', '2026-10-05T13:00:00.000Z'),
        ],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

/** Names that appear on more than one button. */
const repeated = () => {
  const names = buttonNames();
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
};

it('names each provider’s Discover models button for its provider', async () => {
  ({ root } = await renderAdmin(<ProvidersSection />));
  expect(buttonNames()).toEqual(
    expect.arrayContaining([
      'Discover models from Primary OpenAI',
      'Discover models from Backup OpenAI',
    ]),
  );
  expect(repeated()).not.toContain('Discover models');
});

it('names each lab group’s Select all for its group', async () => {
  ({ root } = await renderAdmin(<ModelScopePicker selected={[]} onChange={() => undefined} />));
  const names = buttonNames().filter((name) => name.includes('all '));
  expect(names.sort()).toEqual(['Select all Anthropic models', 'Select all OpenAI models']);
});

it('names each audit row’s Details button for its event', async () => {
  ({ root } = await renderAdmin(<AdminAuditPage />, { path: '/admin/audit' }));
  const details = buttonNames().filter((name) => name.startsWith('Details'));
  expect(details.length).toBeGreaterThanOrEqual(2);
  expect(
    details.some((name) => name.startsWith('Details of user.update by admin@example.test')),
  ).toBe(true);
  // The desktop table and the phone list each have one per event (one is
  // hidden by CSS), so two events give two distinct names.
  expect(new Set(details).size).toBe(2);
});

it('tells shareable invitations’ Revoke buttons apart by role and creation time', async () => {
  ({ root } = await renderAdmin(<AdminInvitesPage />));
  const revoke = buttonNames().filter((name) => name.startsWith('Revoke'));
  expect(revoke).toHaveLength(2);
  expect(revoke[0]).toMatch(/^Revoke shareable (user|auditor) invitation created /);
  expect(new Set(revoke).size).toBe(2);
});

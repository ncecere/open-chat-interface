import {
  clampReasoningEffort,
  DEFAULT_ROLE_FEATURES,
  intersectReasoningEfforts,
  normalizeReasoningEfforts,
  REASONING_EFFORTS,
  updateRoleFeaturesSchema,
} from '@oci/shared';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ stored: {} as Record<string, unknown> }));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => mocks.stored[key] ?? {},
  updateSetting: async (key: string, patch: Record<string, unknown>) => {
    mocks.stored[key] = { ...(mocks.stored[key] as object), ...patch };
    return mocks.stored[key];
  },
}));

const { combineFeatures, resolveRoleFeatures, updateRoleFeatures, assertRoleFeature } =
  await import('../../services/role-features.js');
const { assertReasoningEffortSupported } = await import('../../services/reasoning.js');

const search = {
  enabled: true,
  provider: 'tavily' as const,
  baseUrl: null,
  encryptedApiKey: 'secret',
  maxResults: 5,
};
const instance = {
  shareLinks: true,
  temporaryChat: true,
  webSearch: true,
  attachments: true,
  branching: true,
};

describe('role feature defaults', () => {
  it('match the rules that were previously fixed in code, with projects and artifacts off for restricted', () => {
    expect(DEFAULT_ROLE_FEATURES.restricted).toEqual({
      webSearch: true,
      attachments: false,
      shareLinks: false,
      temporaryChat: false,
      branching: true,
      projects: false,
      memory: false,
      artifacts: false,
      accountDeletion: false,
      reasoningEfforts: [...REASONING_EFFORTS],
    });
    for (const role of ['admin', 'auditor', 'user'] as const) {
      expect(DEFAULT_ROLE_FEATURES[role]).toEqual({
        webSearch: true,
        attachments: true,
        shareLinks: true,
        temporaryChat: true,
        branching: true,
        projects: true,
        memory: true,
        artifacts: true,
        // Deleting your own account is off for every role until switched on (v0.10).
        accountDeletion: false,
        reasoningEfforts: [...REASONING_EFFORTS],
      });
    }
  });
});

describe('resolveRoleFeatures', () => {
  it('falls back field by field to the defaults', () => {
    const resolved = resolveRoleFeatures('restricted', {
      roles: { restricted: { attachments: true }, user: { webSearch: false } },
    });
    expect(resolved).toEqual({ ...DEFAULT_ROLE_FEATURES.restricted, attachments: true });
  });

  it('ignores malformed stored values and always keeps instant', () => {
    const resolved = resolveRoleFeatures('user', {
      roles: {
        user: {
          branching: 'no' as unknown as boolean,
          reasoningEfforts: ['high', 'bogus', 'low'] as never,
        },
      },
    });
    expect(resolved.branching).toBe(true);
    expect(resolved.reasoningEfforts).toEqual(['instant', 'low', 'high']);
  });

  it('gives an unknown role the restricted defaults', () => {
    expect(resolveRoleFeatures('owner' as never, undefined)).toEqual(
      DEFAULT_ROLE_FEATURES.restricted,
    );
  });
});

describe('combineFeatures', () => {
  it('requires both the instance and the role', () => {
    const role = { ...DEFAULT_ROLE_FEATURES.user, branching: false };
    expect(combineFeatures({ ...instance, attachments: false }, search, role)).toEqual({
      webSearch: true,
      attachments: false,
      shareLinks: true,
      temporaryChat: true,
      branching: false,
      projects: true,
      // The instance memory switch is off unless saved on.
      memory: false,
      artifacts: true,
      accountDeletion: false,
      reasoningEfforts: [...REASONING_EFFORTS],
    });
  });

  it('offers memory only when the instance switch and the role both allow it', () => {
    const role = DEFAULT_ROLE_FEATURES.user;
    expect(combineFeatures({ ...instance, memory: true }, search, role).memory).toBe(true);
    expect(
      combineFeatures({ ...instance, memory: true }, search, { ...role, memory: false }).memory,
    ).toBe(false);
    expect(combineFeatures({ ...instance, memory: false }, search, role).memory).toBe(false);
    expect(
      combineFeatures({ ...instance, memory: true }, search, DEFAULT_ROLE_FEATURES.restricted)
        .memory,
    ).toBe(false);
  });

  it('takes artifacts from the role alone: there is no instance switch', () => {
    const role = DEFAULT_ROLE_FEATURES.user;
    expect(combineFeatures(instance, search, role).artifacts).toBe(true);
    expect(combineFeatures(instance, search, { ...role, artifacts: false }).artifacts).toBe(false);
  });

  it('takes deleting your own account from the role alone: there is no instance switch', () => {
    const role = DEFAULT_ROLE_FEATURES.user;
    expect(combineFeatures(instance, search, role).accountDeletion).toBe(false);
    expect(combineFeatures({}, search, { ...role, accountDeletion: true }).accountDeletion).toBe(
      true,
    );
  });

  it('takes projects from the role alone: there is no instance switch', () => {
    const role = DEFAULT_ROLE_FEATURES.user;
    expect(combineFeatures(instance, search, role).projects).toBe(true);
    expect(combineFeatures(instance, search, { ...role, projects: false }).projects).toBe(false);
  });

  it('offers web search only when a provider can run', () => {
    const role = DEFAULT_ROLE_FEATURES.user;
    expect(combineFeatures(instance, { ...search, encryptedApiKey: null }, role).webSearch).toBe(
      false,
    );
    expect(combineFeatures(instance, search, { ...role, webSearch: false }).webSearch).toBe(false);
  });
});

describe('updateRoleFeatures', () => {
  it('stores only sent fields for the one role', async () => {
    mocks.stored.roleFeatures = { roles: { admin: { branching: false } } };
    const next = await updateRoleFeatures('user', { webSearch: false });
    expect(next).toEqual({ ...DEFAULT_ROLE_FEATURES.user, webSearch: false });
    expect(mocks.stored.roleFeatures).toEqual({
      roles: { admin: { branching: false }, user: { webSearch: false } },
    });
    await expect(assertRoleFeature('user', 'webSearch')).rejects.toMatchObject({
      status: 403,
      message: 'Web search is not available for your role',
    });
    await expect(assertRoleFeature('user', 'branching')).resolves.toBeUndefined();
  });
});

describe('updateRoleFeaturesSchema', () => {
  it('accepts a single changed field without filling in others', () => {
    expect(updateRoleFeaturesSchema.parse({ attachments: true })).toEqual({ attachments: true });
  });

  it.each([
    {},
    { personas: true },
    { reasoningEfforts: [] },
    { reasoningEfforts: ['low', 'high'] },
    { reasoningEfforts: ['instant', 'instant'] },
  ])('rejects %j', (body) => {
    expect(updateRoleFeaturesSchema.safeParse(body).success).toBe(false);
  });
});

describe('reasoning helpers', () => {
  it('normalizes, intersects and clamps levels', () => {
    expect(normalizeReasoningEfforts(['high', 'low', 'high'])).toEqual(['instant', 'low', 'high']);
    expect(intersectReasoningEfforts(['low', 'medium', 'high'], ['instant', 'low'])).toEqual([
      'low',
    ]);
    expect(clampReasoningEffort('medium', ['instant', 'low', 'medium'])).toBe('medium');
    expect(clampReasoningEffort('high', ['instant', 'low'])).toBe('instant');
    expect(clampReasoningEffort('high', ['low', 'medium'])).toBe('low');
    expect(clampReasoningEffort('high', [])).toBe('instant');
  });

  it('refuses a level the role withholds before consulting the model', () => {
    const status = (run: () => void) => {
      try {
        run();
        return null;
      } catch (error) {
        return (error as { status?: number }).status;
      }
    };
    expect(status(() => assertReasoningEffortSupported('high', ['high'], ['instant', 'low']))).toBe(
      403,
    );
    expect(status(() => assertReasoningEffortSupported('low', ['high'], ['instant', 'low']))).toBe(
      422,
    );
    expect(() =>
      assertReasoningEffortSupported('low', ['low', 'high'], ['instant', 'low']),
    ).not.toThrow();
    expect(() => assertReasoningEffortSupported(undefined, [], ['instant'])).not.toThrow();
  });
});

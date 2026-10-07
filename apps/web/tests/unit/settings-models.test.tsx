// @vitest-environment happy-dom
import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModelsPage } from '../../src/routes/settings/models';
import { alerts, button, cleanup, click, renderAdmin } from './admin-test-utils';
import { styleFor } from './css-test-utils';

/**
 * Settings → Models (v0.10): a default model and reasoning level stored with
 * the account, offered within what the role and the model allow, and a note
 * when a saved default no longer applies.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function model(
  slug: string,
  displayName: string,
  supportedEfforts: ReasoningEffort[],
  isDefault = false,
): CatalogModel {
  return {
    id: slug,
    slug,
    displayName,
    description: null,
    providerId: 'p',
    providerKind: 'openai-compatible',
    providerLabel: 'Provider',
    upstreamModelId: slug,
    capabilities: supportedEfforts.length ? ['effort_control'] : [],
    labId: null,
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts,
    isDefault,
    sortOrder: 0,
  } as CatalogModel;
}

let preferences: { defaultModelSlug: string | null; defaultEffort: ReasoningEffort | null };
let chat: Record<string, unknown>;
let root: Root | undefined;

beforeEach(() => {
  preferences = { defaultModelSlug: null, defaultEffort: null };
  chat = {
    defaultEffort: 'low',
    instanceDefaultEffort: 'low',
    defaultModelSlug: null,
    defaultProblems: [],
    reasoningEfforts: ['instant', 'low', 'medium', 'high'],
  };
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me') return { user: { id: 'u1', name: 'Pat' }, preferences, features: {}, chat };
    if (path === '/models')
      return {
        models: [
          model('everyday', 'Everyday', [], true),
          model('thinker', 'Thinker', ['instant', 'low', 'high']),
        ],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockImplementation(async (_path: string, body: typeof preferences) => {
    preferences = { ...preferences, ...body };
    chat = { ...chat, defaultModelSlug: preferences.defaultModelSlug };
    return { preferences };
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async () => {
  ({ root } = await renderAdmin(<SettingsModelsPage />, { path: '/settings/models' }));
};

const trigger = (id: string) => document.getElementById(id) as HTMLButtonElement;

/** Radix select: the trigger and items open and select on a plain click. */
async function choose(id: string, label: string) {
  await click(trigger(id));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!option) throw new Error(`No option "${label}" in ${id}`);
  await click(option);
}

/** The labels a select offers; picking the current value again closes it. */
async function options(id: string): Promise<string[]> {
  await click(trigger(id));
  const all = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const labels = all.map((option) => option.textContent ?? '');
  const current = all.find((option) => option.getAttribute('aria-selected') === 'true') ?? all[0];
  if (current) await click(current);
  return labels;
}

describe('Settings → Models defaults', () => {
  it('starts at the instance defaults and offers only what the role and model allow', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Models');
    expect(trigger('default-model').textContent).toContain('Instance default (Everyday)');
    // The instance model has no levels, so the level waits for a model that has.
    expect(trigger('default-effort').disabled).toBe(true);
    expect(document.body.textContent).toContain('Everyday has no reasoning levels.');
    expect(button('Save defaults').disabled).toBe(true);
    expect(await options('default-model')).toEqual([
      'Instance default (Everyday)',
      'Everyday',
      'Thinker',
    ]);
  });

  it('saves a default model and level with the account', async () => {
    await render();
    await choose('default-model', 'Thinker');
    expect(trigger('default-effort').disabled).toBe(false);
    // Medium is a role level, but Thinker does not offer it.
    expect(await options('default-effort')).toEqual([
      'Instance default (Low)',
      'Instant',
      'Low',
      'High',
    ]);
    await choose('default-effort', 'High');
    await click(button('Save defaults'));

    expect(api.patch).toHaveBeenCalledWith('/me/preferences', {
      defaultModelSlug: 'thinker',
      defaultEffort: 'high',
    });
    expect(document.body.textContent).toContain('Saved');
    expect(document.body.textContent).toContain('your default');
  });

  it('drops a level the newly chosen model does not offer', async () => {
    preferences = { defaultModelSlug: 'thinker', defaultEffort: 'high' };
    chat = { ...chat, defaultModelSlug: 'thinker', defaultEffort: 'high' };
    await render();
    expect(trigger('default-effort').textContent).toContain('High');
    await choose('default-model', 'Everyday');
    await click(button('Save defaults'));
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', {
      defaultModelSlug: 'everyday',
      defaultEffort: null,
    });
  });

  it('says when a saved default no longer applies, and lets it be cleared', async () => {
    preferences = { defaultModelSlug: 'retired', defaultEffort: 'medium' };
    chat = { ...chat, defaultProblems: ['model', 'effort'] };
    await render();
    const note = document.querySelector('[role="note"]')?.textContent ?? '';
    expect(note).toContain('Your default model is no longer available to you');
    expect(note).toContain('Your default reasoning level, Medium, is no longer available');
    expect(note).toContain('the instance default (Low) applies');
    // The retired model shows as the instance default; saving clears it.
    expect(trigger('default-model').textContent).toContain('Instance default');
    expect(button('Save defaults').disabled).toBe(false);
    await click(button('Save defaults'));
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', {
      defaultModelSlug: null,
      defaultEffort: null,
    });
  });

  it('shows why the server refused a default', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    api.patch.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'That model is not available to your role.'),
    );
    await render();
    await choose('default-model', 'Thinker');
    await click(button('Save defaults'));
    expect(alerts()).toContain('That model is not available to your role.');
  });
});

/**
 * #243: at 390 px each model kept its capability chips beside its name, so
 * the name, provider and description had about 130 px. Phone width is the
 * compiled CSS with no `sm:` rule applied.
 */
describe('Settings → Models on a phone', () => {
  it('puts the capabilities under the name, which wraps with its badges whole', async () => {
    await render();
    const name = [...document.querySelectorAll('p')].find(
      (element) => element.textContent === 'Thinker',
    )!;
    const row = name.parentElement!.parentElement!.parentElement!;
    expect((await styleFor(row.className))['flex-direction']).toBe('column');
    expect((await styleFor(name.parentElement!.className))['flex-wrap']).toBe('wrap');
    // The capabilities: the row's second part, below the name on a phone.
    expect(row.children).toHaveLength(2);
    const chips = row.lastElementChild!;
    expect((await styleFor(chips.className))['justify-content']).toBeUndefined();

    const badge = [...document.querySelectorAll('span')].find(
      (element) => element.textContent === 'instance default',
    )!;
    expect((await styleFor(badge.className))['white-space']).toBe('nowrap');
  });
});

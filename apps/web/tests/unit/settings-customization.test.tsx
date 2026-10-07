// @vitest-environment happy-dom
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUGGESTED_TRAITS, withTrait } from '../../src/lib/traits';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { SettingsCustomizationPage } from '../../src/routes/settings/customization';
import { button, cleanup, click, findButton, renderAdmin } from './admin-test-utils';

/**
 * Settings → Customization (v0.9.1): Appearance, a working "Invert Send/New
 * Line Behavior" kept per browser, no "Hide Personal Information", and Save
 * only once something differs from what is stored.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/me')
      return {
        user: { id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user' },
        preferences: {
          displayName: 'Ada',
          occupation: null,
          traits: ['concise'],
          additionalContext: null,
        },
        features: {},
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.patch.mockReset().mockResolvedValue({ preferences: {} });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  localStorage.clear();
});

const render = async () => {
  ({ root } = await renderAdmin(
    <ThemeProvider>
      <SettingsCustomizationPage />
    </ThemeProvider>,
    { path: '/settings/customization' },
  ));
};

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function toggle(label: string): HTMLButtonElement {
  const labelElement = [...document.querySelectorAll('p')].find(
    (candidate) => candidate.textContent === label,
  )!;
  return document.querySelector(`[aria-labelledby="${labelElement.id}"]`) as HTMLButtonElement;
}

function radio(label: string): HTMLInputElement {
  return [...document.querySelectorAll<HTMLLabelElement>('[role="radiogroup"] label')]
    .find((candidate) => candidate.textContent === label)!
    .querySelector('input')!;
}

describe('Settings → Customization', () => {
  it('no longer offers Hide Personal Information', async () => {
    await render();
    expect(document.body.textContent).not.toContain('Hide Personal Information');
  });

  it('chooses Light, Dark or System from an accessible group, kept in this browser', async () => {
    await render();
    const group = document.querySelector('[role="radiogroup"]')!;
    const labelledBy = document.getElementById(group.getAttribute('aria-labelledby')!);
    expect(labelledBy?.textContent).toBe('Appearance');
    expect(
      [...group.querySelectorAll('input[type="radio"]')].map(
        (input) => (input as HTMLInputElement).value,
      ),
    ).toEqual(['light', 'dark', 'system']);

    await click(radio('Light'));
    expect(radio('Light').checked).toBe(true);
    expect(localStorage.getItem('oci.theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);

    await click(radio('System'));
    expect(localStorage.getItem('oci.theme')).toBe('system');
  });

  it('keeps Invert Send/New Line Behavior in this browser', async () => {
    await render();
    const invert = toggle('Invert Send/New Line Behavior');
    expect(invert.getAttribute('aria-checked')).toBe('false');
    await click(invert);
    expect(localStorage.getItem('oci.invertSend')).toBe('true');
    expect(toggle('Invert Send/New Line Behavior').getAttribute('aria-checked')).toBe('true');
  });

  it('enables Save only when the personalisation differs from what is saved', async () => {
    await render();
    const save = button('Save Preferences');
    expect(save.disabled).toBe(true);

    const name = document.getElementById('name') as HTMLInputElement;
    await type(name, 'Ada L.');
    expect(button('Save Preferences').disabled).toBe(false);
    // Back to what is stored (surrounding spaces are not a change).
    await type(name, ' Ada ');
    expect(button('Save Preferences').disabled).toBe(true);

    // Removing a trait is a change.
    await click(button('concise×'));
    expect(button('Save Preferences').disabled).toBe(false);
    await type(name, 'Ada L.');
    await click(button('Save Preferences'));
    expect(api.patch).toHaveBeenCalledWith('/me/preferences', {
      displayName: 'Ada L.',
      occupation: null,
      traits: [],
      additionalContext: null,
    });
    expect(document.body.textContent).toContain('Saved');
  });

  it('offers the introduction’s traits, and Thorough replaces Concise (#96)', async () => {
    await render();
    const offered = new Set<string>(SUGGESTED_TRAITS);
    const suggestions = () =>
      [...document.querySelectorAll('button')]
        .map((candidate) => candidate.textContent?.trim() ?? '')
        .filter((text) => offered.has(text));
    // 'concise' is already chosen, so it is not offered again.
    expect(suggestions()).toEqual(SUGGESTED_TRAITS.filter((trait) => trait !== 'concise'));
    await click(button('thorough'));
    expect(findButton('concise×')).toBeUndefined();
    expect(button('thorough×')).toBeTruthy();
  });
});

describe('choosing traits', () => {
  it('drops the opposite of a trait, whatever its case', () => {
    expect(withTrait(['Concise', 'patient'], 'thorough')).toEqual(['patient', 'thorough']);
    expect(withTrait(['formal'], 'casual')).toEqual(['casual']);
    expect(withTrait(['direct'], 'patient')).toEqual(['direct', 'patient']);
    expect(withTrait(['direct'], 'Direct')).toEqual(['direct']);
    expect(withTrait(['direct'], '  ')).toEqual(['direct']);
  });
});

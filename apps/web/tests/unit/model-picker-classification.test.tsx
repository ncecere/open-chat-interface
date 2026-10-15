// @vitest-environment happy-dom
import type { CatalogModel, ClassificationResponse } from '@oci/shared';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../../src/components/chat/model-picker';
import { ThemeProvider } from '../../src/providers/theme-provider';

type Props = ComponentProps<typeof ModelPicker>;

function model(slug: string, displayName: string): CatalogModel {
  return {
    id: slug,
    slug,
    displayName,
    description: `${displayName} description`,
    providerId: 'gateway',
    providerKind: 'openai-compatible',
    providerLabel: 'Local Gateway',
    upstreamModelId: slug,
    capabilities: [],
    labId: null,
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportedEfforts: [],
    isDefault: false,
    sortOrder: 0,
  };
}

const models = [model('approved', 'Approved model'), model('plain', 'Plain model')];

function classification(mode: 'warn' | 'block'): ClassificationResponse {
  return {
    mode,
    classes: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
    models: [
      { slug: 'approved', displayName: 'Approved model', status: 'ok', missing: [] },
      {
        slug: 'plain',
        displayName: 'Plain model',
        status: mode === 'block' ? 'blocked' : 'warn',
        missing: [
          { id: 'c1', name: 'Student records' },
          { id: 'c2', name: 'Health data' },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onSelect = vi.fn();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(props: Partial<Props> = {}) {
  await act(() =>
    root.render(
      <ThemeProvider>
        <ModelPicker models={models} selected={models[0]!} onSelect={onSelect} {...props} />
      </ThemeProvider>,
    ),
  );
  await act(() => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
}
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const option = (name: string) => options().find((node) => node.textContent?.includes(name))!;
const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
async function press(key: string) {
  await act(() => {
    search().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('model picker with data classes (v0.14, #395)', () => {
  it('keeps a blocked model listed, aria-disabled, with the classes in words', async () => {
    await open({ classification: classification('block') });
    expect(options()).toHaveLength(2);
    const plain = option('Plain model');
    expect(plain.getAttribute('aria-disabled')).toBe('true');
    // Text, not colour alone, and part of the option's name.
    expect(plain.textContent).toContain('Not approved for Student records and Health data');
    expect(plain.querySelector('[data-classification-note="blocked"]')).not.toBeNull();
    expect(option('Approved model').getAttribute('aria-disabled')).toBeNull();
    expect(option('Approved model').textContent).not.toContain('Not approved');
  });

  it('does not choose a blocked model with a click', async () => {
    await open({ classification: classification('block') });
    await act(() => option('Plain model').click());
    expect(onSelect).not.toHaveBeenCalled();
    // Still open: nothing was chosen.
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('chooses an approved one as always', async () => {
    await open({ classification: classification('block'), selected: models[1]! });
    await act(() => option('Approved model').click());
    expect(onSelect).toHaveBeenCalledWith(models[0]);
  });

  it('reaches a blocked model with the arrow keys, which announce it, and Enter does not choose it', async () => {
    await open({ classification: classification('block') });
    await press('ArrowDown');
    // The search box keeps focus; the blocked option is the active descendant.
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('aria-activedescendant')).toBe(option('Plain model').id);
    await press('Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it('in warn, the model is selectable, with an amber note', async () => {
    await open({ classification: classification('warn') });
    const plain = option('Plain model');
    expect(plain.getAttribute('aria-disabled')).toBeNull();
    const note = plain.querySelector('[data-classification-note="warn"]');
    expect(note?.textContent).toBe(
      'Not approved for Student records and Health data. You can still use it; the administrator is told.',
    );
    expect(note?.className).toContain('--warning');
    await act(() => plain.click());
    expect(onSelect).toHaveBeenCalledWith(models[1]);
  });

  it('is exactly as before with no classification, or with it off', async () => {
    await open();
    expect(document.querySelector('[data-classification-note]')).toBeNull();
    await act(() => root.unmount());
    root = createRoot(container);
    await open({ classification: { mode: 'off', classes: [], models: [] } });
    expect(document.querySelector('[data-classification-note]')).toBeNull();
    expect(options().every((node) => node.getAttribute('aria-disabled') === null)).toBe(true);
  });
});

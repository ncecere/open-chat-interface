// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PanelHeader } from '../../src/components/artifacts/artifact-panel/panel-header';
import { ModelPicker } from '../../src/components/chat/model-picker';
import { Dialog, DialogContent } from '../../src/components/ui/dialog';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { clippedOnTouch, clippedWithoutTooltip } from './truncation';

/**
 * #312: with the artifact panel open, its title was cut to "Walk7 Research
 * Dataset ..." beside Copy and Download, and at 1024 px the composer's model
 * picker read "GPT-...", neither with a tooltip. The title now wraps (a
 * tooltip is no help on touch, #244); the picker keeps to one line (#109)
 * with a tooltip, and on touch the list it opens names the model in full.
 */
const TITLE = 'Walk7 Research Dataset CSV Parser';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const chrome = (docked: boolean) => ({
  docked,
  headingId: 'panel-heading',
  onClose: () => undefined,
  fullScreen: false,
  onToggleFullScreen: () => undefined,
});

it('wraps the docked panel’s title rather than cutting it short', async () => {
  await act(async () =>
    root.render(
      <PanelHeader chrome={chrome(true)} title={TITLE} description="Code · version 1">
        <button type="button">Copy</button>
        <button type="button">Download</button>
      </PanelHeader>,
    ),
  );
  expect(container.querySelector('h2')?.textContent).toBe(TITLE);
  expect(await clippedOnTouch(container)).toEqual([]);
});

it('wraps the title of the panel shown as a dialog too', async () => {
  await act(async () =>
    root.render(
      <Dialog open>
        <DialogContent>
          <PanelHeader chrome={chrome(false)} title={TITLE} description="Code · version 1" />
        </DialogContent>
      </Dialog>,
    ),
  );
  const heading = document.querySelector('[role="dialog"] h2');
  expect(heading?.textContent).toBe(TITLE);
  expect(await clippedOnTouch(heading!.parentElement!)).toEqual([]);
});

it('gives the model picker’s shortened name a tooltip', async () => {
  const model = {
    id: 'm',
    slug: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    description: null,
    providerId: 'p',
    providerKind: 'openai-compatible',
    providerLabel: 'P',
    upstreamModelId: 'gpt-4.1-mini',
    capabilities: [],
    labId: 'openai',
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    isDefault: true,
    sortOrder: 0,
  } as unknown as CatalogModel;
  await act(async () =>
    root.render(
      <ThemeProvider>
        <ModelPicker models={[model]} selected={model} onSelect={() => undefined} />
      </ThemeProvider>,
    ),
  );
  expect(container.textContent).toContain('GPT-4.1 mini');
  expect(await clippedWithoutTooltip(container)).toEqual([]);
});

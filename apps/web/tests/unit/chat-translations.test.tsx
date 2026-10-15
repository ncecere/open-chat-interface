// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactMeta } from '../../src/components/artifacts/artifact-card';
import { sizeLabel } from '../../src/components/artifacts/artifact-drafts';
import {
  CapacityWait,
  capacityWaitLabel,
  waitEstimate,
} from '../../src/components/chat/capacity-wait';
import { nameTableFullscreen } from '../../src/components/chat/streamdown-control-names';
import { workSummary } from '../../src/components/chat/work-summary';
import { reasonTexts, warnedText } from '../../src/lib/classification';
import { activateLocale } from '../../src/lib/i18n/state';
import { quotedMessage, repeatedOpeningPositions } from '../../src/lib/message-excerpt';
import { preloadCatalogs } from './i18n-test-utils';

/**
 * What the chat area says in Spanish and Arabic: plural forms, numbers and lists
 * through the formatter, a sentence with a name in it, and the control names
 * that are read back by pattern. English is the default of every other test.
 */
vi.mock('../../src/hooks/use-media-query', () => ({ useMediaQuery: () => false }));

beforeEach(async () => {
  await preloadCatalogs();
});
afterEach(async () => {
  await activateLocale('en');
});

const steps = (count: number) =>
  Array.from({ length: count }, () => ({
    toolId: 'web_search',
    label: 'Web search',
    state: 'done' as const,
  }));

describe('plurals', () => {
  it('say how many times a step ran, in the forms each language needs', async () => {
    expect(workSummary({ reasoning: false, steps: steps(1) })).toBe('Searched the web');
    expect(workSummary({ reasoning: false, steps: steps(2) })).toBe('Searched the web twice');
    expect(workSummary({ reasoning: false, steps: steps(5) })).toBe('Searched the web 5 times');
    await activateLocale('es');
    expect(workSummary({ reasoning: false, steps: steps(1) })).toBe('Buscó en la web');
    expect(workSummary({ reasoning: false, steps: steps(2) })).toBe('Buscó en la web dos veces');
    expect(workSummary({ reasoning: false, steps: steps(5) })).toBe('Buscó en la web 5 veces');
    await activateLocale('ar');
    expect(workSummary({ reasoning: false, steps: steps(1) })).toBe('بحث في الويب');
    expect(workSummary({ reasoning: false, steps: steps(2) })).toBe('بحث في الويب مرتين');
    expect(workSummary({ reasoning: false, steps: steps(3) })).toContain('مرات');
    expect(workSummary({ reasoning: false, steps: steps(11) })).toContain('مرة');
  });

  it('count the size of a draft and the minutes of a wait', async () => {
    expect(sizeLabel('one\ntwo\n')).toBe('2 lines · 8 characters');
    expect(sizeLabel('x')).toBe('1 line · 1 character');
    expect(waitEstimate(200)).toBe('about 3 minutes');
    await activateLocale('es');
    expect(sizeLabel('one\ntwo\n')).toBe('2 líneas · 8 caracteres');
    expect(waitEstimate(60 * 60)).toBe('unos 60 minutos');
    await activateLocale('ar');
    expect(sizeLabel('x')).toContain('سطر واحد');
    expect(waitEstimate(8)).toBe('بضع ثوانٍ');
  });
});

describe('a sentence with a name or a list in it', () => {
  it('keeps the model and the place in the queue where the language puts them', async () => {
    const wait = {
      state: 'waiting',
      model: 'Claude Haiku',
      position: 3,
      estimatedWaitSeconds: 40,
      waitedSeconds: 0,
    } as unknown as Parameters<typeof capacityWaitLabel>[0];
    expect(capacityWaitLabel(wait)).toBe('Waiting for Claude Haiku — you’re number 3');
    await activateLocale('es');
    expect(capacityWaitLabel(wait)).toBe('Esperando a Claude Haiku: eres el número 3');
    await activateLocale('ar');
    expect(capacityWaitLabel(wait)).toContain('Claude Haiku');
  });

  it('joins class names with the language’s own list', async () => {
    const part = {
      mode: 'warn',
      point: 'tool',
      missing: ['Student records', 'Health data'],
    } as Parameters<typeof warnedText>[0];
    expect(warnedText(part)).toContain('Student records and Health data');
    await activateLocale('es');
    expect(warnedText(part)).toContain('Student records y Health data');
    await activateLocale('ar');
    expect(warnedText(part)).toContain('Student records');
    expect(warnedText(part)).toContain('Health data');
  });

  it('puts connector names in the right plural', async () => {
    const entry = {
      id: 'c1',
      name: 'Student records',
      reasons: ['connector'],
      connectorNames: ['SIS', 'Docs'],
    } as unknown as Parameters<typeof reasonTexts>[0];
    expect(reasonTexts(entry, 'thread')).toEqual(['from the SIS and Docs connectors']);
    await activateLocale('es');
    expect(reasonTexts(entry, 'thread')).toEqual(['de los conectores SIS y Docs']);
  });

  it('names an artifact by its kind and version', async () => {
    const markdown = { kind: 'markdown', version: 2, language: null } as const;
    expect(artifactMeta(markdown)).toBe('Document · version 2');
    await activateLocale('es');
    expect(artifactMeta(markdown)).toBe('Documento · versión 2');
  });
});

describe('capacity wait, rendered', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it('reads in the language shown, and follows a switch', async () => {
    const wait = {
      state: 'waiting',
      model: 'Claude Haiku',
      position: null,
      estimatedWaitSeconds: 8,
      waitedSeconds: 0,
    } as unknown as Parameters<typeof CapacityWait>[0]['wait'];
    await act(() => root.render(<CapacityWait wait={wait} onStop={() => undefined} />));
    expect(container.textContent).toContain('Waiting for Claude Haiku');
    expect(container.textContent).toContain('Your reply should start in a few seconds.');
    await act(() => activateLocale('es'));
    expect(container.textContent).toContain('Esperando a Claude Haiku');
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Dejar de esperar');
  });
});

describe('the names of a reply’s controls', () => {
  it('number positions in the language, and quote the opening words', async () => {
    expect(quotedMessage('Again.', 'question 2')).toBe('“Again.” (question 2)');
    await activateLocale('es');
    expect(
      repeatedOpeningPositions([
        { role: 'user', excerpt: 'Hola' },
        { role: 'user', excerpt: 'Hola' },
      ]),
    ).toEqual(['pregunta 1', 'pregunta 2']);
    expect(quotedMessage('Hola', 'pregunta 2')).toBe('“Hola” (pregunta 2)');
    await activateLocale('ar');
    expect(quotedMessage('مرحبا')).toBe('«مرحبا»');
  });

  it.each(['en', 'es', 'ar'] as const)(
    'reads a table’s opener back to name its full-screen view in %s',
    async (locale) => {
      await activateLocale(locale);
      const { translate } = await import('../../src/lib/i18n');
      const message = quotedMessage('Plan', 'reply 3');
      const opener = document.createElement('button');
      opener.setAttribute(
        'aria-label',
        translate('chat.controls.tableViewInMessage', { n: '2', message }),
      );
      const overlay = document.createElement('div');
      overlay.innerHTML = `<button title="${translate('chat.streamdown.copyTable')}"></button><button title="${translate('chat.streamdown.exitFullscreen')}"></button>`;
      nameTableFullscreen(overlay, opener);
      expect(overlay.getAttribute('aria-label')).toBe(
        translate('chat.controls.tableFullScreenInMessage', { n: '2', message }),
      );
      expect(
        [...overlay.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
      ).toEqual([
        translate('chat.controls.tableCopyInMessage', { n: '2', message }),
        translate('chat.controls.exitFullScreen'),
      ]);
    },
  );
});

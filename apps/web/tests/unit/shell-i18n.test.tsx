// @vitest-environment happy-dom
import { INACTIVE_READ_ONLY_STATUS } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SkipLink } from '../../src/components/layout/skip-link';
import { ThreadSearchResultList } from '../../src/components/layout/thread-search-results';
import { AppToaster } from '../../src/components/ui/app-toaster';
import { LoadingOverlay } from '../../src/components/ui/reveal-when-loaded';
import { FullPageSpinner } from '../../src/components/ui/spinner';
import { searchResultsAnnouncement } from '../../src/hooks/use-thread-search';
import { documentTitle, pageTitleFor, pageWithin } from '../../src/lib/document-title';
import { activateLocale } from '../../src/lib/i18n/state';
import { SHORTCUTS, shortcutKeys } from '../../src/lib/keyboard-shortcuts';
import { readOnlyMessage, readOnlyShortReason } from '../../src/lib/read-only';
import { isReadOnlyRefusal } from '../../src/lib/read-only-refusals';
import { cleanup, renderAdmin } from './admin-test-utils';
import { preloadCatalogs } from './i18n-test-utils';

// The app shell and the shared components in every language: what a person
// reads (a plural, a title in the tab, a maintenance notice) and what code
// reads back from it (a refusal found by its text).

beforeAll(preloadCatalogs);
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  await activateLocale('en');
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(node));
  return container;
}

describe('the count of search results', () => {
  it('is said as a plural in each language', async () => {
    expect(searchResultsAnnouncement(0)).toBe('No conversations matched.');
    expect(searchResultsAnnouncement(1)).toBe('1 conversation found.');
    expect(searchResultsAnnouncement(4)).toBe('4 conversations found.');

    await activateLocale('es');
    expect(searchResultsAnnouncement(0)).toBe('Ninguna conversación coincide.');
    expect(searchResultsAnnouncement(1)).toBe('Se encontró 1 conversación.');
    expect(searchResultsAnnouncement(4)).toBe('Se encontraron 4 conversaciones.');

    // Arabic has a form for two, a few (3 to 10) and many (11 to 99).
    await activateLocale('ar');
    expect(searchResultsAnnouncement(1)).toContain('محادثة واحدة');
    expect(searchResultsAnnouncement(2)).toContain('محادثتين');
    expect(searchResultsAnnouncement(3)).toContain('محادثات');
    expect(searchResultsAnnouncement(11)).toMatch(/محادثة\.$/);
  });
});

describe('the title in the tab', () => {
  it('is the same English as before, and follows the language', async () => {
    expect(pageTitleFor('/settings/memory')).toBe('Memory · Settings');
    expect(documentTitle(pageTitleFor('/settings/memory'), 'Acme')).toBe(
      'Memory · Settings · Acme',
    );
    expect(pageWithin('Marcus Bell', '/auth/login')).toBe('Marcus Bell · Sign in');
    expect(documentTitle(null, 'Acme')).toBe('Acme');

    await activateLocale('es');
    expect(pageTitleFor('/settings/memory')).toBe('Memoria · Configuración');
    expect(pageTitleFor('/auth/login')).toBe('Iniciar sesión');
    expect(documentTitle('Memoria · Configuración', 'Acme')).toBe('Memoria · Configuración · Acme');

    await activateLocale('ar');
    expect(pageTitleFor('/share/abc')).toBe('محادثة مشاركة');
  });

  it('leaves the administration console in English', async () => {
    await activateLocale('es');
    expect(pageTitleFor('/admin')).toMatch(/ · Admin$/);
    expect(pageTitleFor('/admin/users')).toMatch(/ · Admin$/);
  });
});

describe('the maintenance notice', () => {
  const until = '2027-03-04T10:00:00Z';
  const on = { ...INACTIVE_READ_ONLY_STATUS, active: true, reason: 'Upgrading the database' };

  it('keeps its English wording', () => {
    expect(readOnlyShortReason(on)).toBe('Read-only for maintenance');
    expect(readOnlyMessage(on)).toBe(
      'Read-only for maintenance: you can read, search and export, but changes can’t be saved. Upgrading the database.',
    );
    expect(readOnlyMessage({ ...on, until })).toMatch(
      /^Read-only for maintenance until about .+: you can read/,
    );
  });

  it('is in the language showing, with the administrator’s own words kept', async () => {
    await activateLocale('es');
    const message = readOnlyMessage({ ...on, until });
    expect(message).toMatch(
      /^Solo lectura por mantenimiento hasta aproximadamente las .+: puedes leer/,
    );
    expect(message).toContain('Upgrading the database.');
    expect(readOnlyShortReason(on)).toBe('Solo lectura por mantenimiento');
  });

  it('is still recognised as a refusal once the language has changed', async () => {
    const english = readOnlyMessage(on);
    await activateLocale('es');
    const spanish = readOnlyMessage(on);
    // Written in one language and looked at in another, as after a switch.
    expect(isReadOnlyRefusal(spanish)).toBe(true);
    expect(isReadOnlyRefusal(english)).toBe(true);
    await activateLocale('ar');
    expect(isReadOnlyRefusal(readOnlyMessage(on))).toBe(true);
    expect(isReadOnlyRefusal('The name is already taken.')).toBe(false);
  });
});

describe('the keyboard shortcuts', () => {
  it('describe themselves in the language showing; the keys stay as typed', async () => {
    expect(SHORTCUTS['toggle-sidebar'].label).toBe('Toggle Sidebar');
    await activateLocale('es');
    expect(SHORTCUTS['toggle-sidebar'].label).toBe('Mostrar u ocultar la barra lateral');
    expect(shortcutKeys('new-chat', false)).toEqual(['Ctrl', 'Shift', 'O']);
  });
});

describe('shared components', () => {
  const result = {
    thread: { id: 't1', title: 'Quarterly plan', archived: true },
    matches: [{ messageId: 'm1', role: 'user', snippet: 'the plan' }],
    titleHighlight: '',
  } as unknown as Parameters<typeof ThreadSearchResultList>[0]['results'][number];

  it('show the skip link and the loading labels in each language', async () => {
    const node = (
      <>
        <SkipLink />
        <FullPageSpinner />
        <LoadingOverlay />
        <LoadingOverlay label="Loading files" />
      </>
    );
    const container = await render(node);
    const read = () => ({
      skip: container.querySelector('a')?.textContent,
      statuses: [...container.querySelectorAll('[role=status]')].map((e) =>
        e.getAttribute('aria-label'),
      ),
    });
    expect(read()).toEqual({
      skip: 'Skip to main content',
      statuses: ['Loading page', 'Loading', 'Loading files'],
    });

    await act(async () => activateLocale('es'));
    expect(read()).toEqual({
      skip: 'Saltar al contenido principal',
      statuses: ['Cargando la página', 'Cargando', 'Loading files'],
    });

    await act(async () => activateLocale('ar'));
    expect(read().skip).toBe('التخطي إلى المحتوى الرئيسي');

    // Pseudo-locale: nothing left as plain English.
    await act(async () => activateLocale('en-XA'));
    expect(read().skip).toMatch(/^\[.*\]$/);
    expect(read().skip).not.toContain('Skip');
  });

  it('label a search result for the page’s direction, not the snippet’s', async () => {
    const { root: listRoot, container } = await renderAdmin(
      <ThreadSearchResultList results={[result]} activeThreadId={undefined} />,
    );
    const label = () => container.querySelector('span[dir]:not([dir=auto])');
    expect(label()?.textContent).toBe('You: ');
    expect(label()?.getAttribute('dir')).toBe('ltr');
    expect(container.textContent).toContain('Archived');

    await act(async () => activateLocale('ar'));
    expect(label()?.textContent).toBe('أنت: ');
    expect(label()?.getAttribute('dir')).toBe('rtl');
    expect(container.textContent).toContain('مؤرشفة');
    await cleanup(listRoot);
  });
});

describe('the notices region', () => {
  it('is named for a screen reader in the language showing', async () => {
    const container = await render(<AppToaster />);
    const name = () =>
      container.ownerDocument.querySelector('section[aria-label]')?.getAttribute('aria-label');
    expect(name()).toMatch(/^Notifications/);
    await act(async () => activateLocale('es'));
    expect(name()).toMatch(/^Notificaciones/);
    await act(async () => activateLocale('ar'));
    expect(name()).toMatch(/^الإشعارات/);
  });
});

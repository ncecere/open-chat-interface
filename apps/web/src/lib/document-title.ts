import { instanceName } from '@oci/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { findActiveAdminNav } from '~/lib/admin-navigation';
import { type MessageKey, translate } from '~/lib/i18n';

/**
 * The browser tab's title and icon follow Branding (v0.10).
 *
 * The title is "<page> · <app name>", or the app name alone on the chat
 * pages. Pages are named from the path, so a new admin page is named by its
 * entry in the admin navigation without further wiring; a page with a better
 * name of its own (a shared conversation's title) sets it with `usePageTitle`.
 */

/** "<page> · <parent>" and "<page> · <app name>": one message each, so a language can order them. */
const within = (page: string, parent: string) => translate('brand.title.within', { page, parent });

const AUTH_PAGES: Record<string, MessageKey> = {
  '/auth/login': 'brand.title.signIn',
  '/auth/signup': 'brand.title.signUp',
  '/auth/forgot-password': 'brand.title.forgotPassword',
  '/auth/reset-password': 'brand.title.resetPassword',
  '/auth/accept-invite': 'brand.title.acceptInvite',
  '/auth/verify-email': 'brand.title.verifyEmail',
};

const SETTINGS_SECTIONS: Record<string, MessageKey> = {
  '': 'brand.title.settingsAccount',
  '/customization': 'brand.title.settingsCustomization',
  '/memory': 'brand.title.settingsMemory',
  '/history': 'brand.title.settingsHistory',
  '/models': 'brand.title.settingsModels',
  '/sharing': 'brand.title.settingsSharing',
  '/groups': 'brand.title.settingsGroups',
  '/connectors': 'brand.title.settingsConnectors',
  '/attachments': 'brand.title.settingsAttachments',
};

/** The page's own part of the title, or null where the app name alone is right. */
export function pageTitleFor(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const auth = AUTH_PAGES[path];
  if (auth) return translate(auth);
  if (path.startsWith('/share/')) return translate('brand.title.sharedConversation');
  if (path === '/settings' || path.startsWith('/settings/')) {
    // Each section by name, as admin pages are (#110).
    const section = SETTINGS_SECTIONS[path.slice('/settings'.length)];
    const settings = translate('brand.title.settings');
    return section ? within(translate(section), settings) : settings;
  }
  if (path === '/admin' || path.startsWith('/admin/')) {
    const active = findActiveAdminNav(path);
    // The administration console stays in English, its title too.
    return active ? within(active.item.label, 'Admin') : 'Admin';
  }
  return null;
}

/**
 * A page within one named by its path: "Marcus Bell · Users · Admin" for a
 * user's own page, which the path alone names "Users · Admin" (#197).
 */
export function pageWithin(name: string, pathname: string): string {
  const parent = pageTitleFor(pathname);
  return parent ? within(name, parent) : name;
}

export function documentTitle(page: string | null | undefined, appName?: string | null): string {
  const name = instanceName(appName);
  const own = page?.trim();
  return own ? translate('brand.title.withApp', { page: own, app: name }) : name;
}

// A page-provided title, kept outside React state so the one component that
// writes document.title can read it without every page re-rendering.
let override: string | null = null;
const listeners = new Set<() => void>();

function setOverride(value: string | null) {
  override = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The title set by `usePageTitle`, if any. */
export function usePageTitleOverride(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => override,
    () => null,
  );
}

/** Names the current page in the tab (in place of the path's name) while mounted. */
export function usePageTitle(title: string | null | undefined) {
  const value = title?.trim() || null;
  useEffect(() => {
    if (!value) return;
    setOverride(value);
    return () => setOverride(null);
  }, [value]);
}

/**
 * The tab icon for a configured logo, or null for the product's own.
 *
 * Only a same-origin logo is used: an uploaded one (served at
 * /api/branding/logo) or a root-relative path. An external logo URL keeps the
 * default icon, so the browser does not fetch a third-party image for every
 * tab, and the default stays whatever the logo host does.
 */
export function brandIconHref(logoUrl: string | null | undefined): string | null {
  const value = logoUrl?.trim();
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

/**
 * Points every `<link data-brand-icon>` in index.html at `href`, or back at
 * the default it was served with. The default's type and sizes are dropped
 * while a logo is shown: they describe the SVG and ICO, and a browser skips
 * an icon whose declared type does not match.
 */
export function applyBrandIcons(href: string | null, root: Document = document) {
  for (const link of root.querySelectorAll<HTMLLinkElement>('link[data-brand-icon]')) {
    const { dataset } = link;
    if (dataset.defaultHref === undefined) {
      dataset.defaultHref = link.getAttribute('href') ?? '';
      dataset.defaultType = link.getAttribute('type') ?? '';
      dataset.defaultSizes = link.getAttribute('sizes') ?? '';
    }
    if (href) {
      link.setAttribute('href', href);
      link.removeAttribute('type');
      link.removeAttribute('sizes');
      continue;
    }
    link.setAttribute('href', dataset.defaultHref);
    if (dataset.defaultType) link.setAttribute('type', dataset.defaultType);
    if (dataset.defaultSizes) link.setAttribute('sizes', dataset.defaultSizes);
  }
}

import { instanceName } from '@oci/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { findActiveAdminNav } from '~/lib/admin-navigation';

/**
 * The browser tab's title and icon follow Branding (v0.10).
 *
 * The title is "<page> · <app name>", or the app name alone on the chat
 * pages. Pages are named from the path, so a new admin page is named by its
 * entry in the admin navigation without further wiring; a page with a better
 * name of its own (a shared conversation's title) sets it with `usePageTitle`.
 */

const SEPARATOR = ' · ';

const AUTH_PAGES: Record<string, string> = {
  '/auth/login': 'Sign in',
  '/auth/signup': 'Create account',
  '/auth/forgot-password': 'Forgot password',
  '/auth/reset-password': 'Reset password',
  '/auth/accept-invite': 'Accept invitation',
};

const SETTINGS_SECTIONS: Record<string, string> = {
  '': 'Account',
  '/customization': 'Customization',
  '/memory': 'Memory',
  '/history': 'History',
  '/models': 'Models',
  '/sharing': 'Sharing',
  '/connectors': 'Connectors',
  '/attachments': 'Attachments',
};

/** The page's own part of the title, or null where the app name alone is right. */
export function pageTitleFor(pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const auth = AUTH_PAGES[path];
  if (auth) return auth;
  if (path.startsWith('/share/')) return 'Shared conversation';
  if (path === '/settings' || path.startsWith('/settings/')) {
    // Each section by name, as admin pages are (#110).
    const section = SETTINGS_SECTIONS[path.slice('/settings'.length)];
    return section ? `${section}${SEPARATOR}Settings` : 'Settings';
  }
  if (path === '/admin' || path.startsWith('/admin/')) {
    const active = findActiveAdminNav(path);
    return active ? `${active.item.label}${SEPARATOR}Admin` : 'Admin';
  }
  return null;
}

export function documentTitle(page: string | null | undefined, appName?: string | null): string {
  const name = instanceName(appName);
  const own = page?.trim();
  return own ? `${own}${SEPARATOR}${name}` : name;
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

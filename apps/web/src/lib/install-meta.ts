import { brandShortName, brandThemeColor } from '@oci/shared';

/**
 * The install metadata in index.html (#400), kept in step with Branding the
 * way the tab icon is: `<meta name="theme-color" data-brand-theme-color>` and
 * `<meta name="apple-mobile-web-app-title" data-brand-app-title>`.
 *
 * The manifest says the same for every visitor (the instance's default
 * theme); the page knows the mode this person is in, so the browser's bar
 * follows it.
 */

/** The mode the page is in: theme-init.js and the theme provider set a class on <html>. */
export function appliedMode(root: Document = document): 'light' | 'dark' {
  return root.documentElement.classList.contains('light') ? 'light' : 'dark';
}

export function applyInstallMeta(
  branding: { appName?: string | null; shortName?: string | null; colorTheme?: string | null },
  root: Document = document,
) {
  root
    .querySelector<HTMLMetaElement>('meta[data-brand-theme-color]')
    ?.setAttribute('content', brandThemeColor(branding.colorTheme, appliedMode(root)));
  root
    .querySelector<HTMLMetaElement>('meta[data-brand-app-title]')
    ?.setAttribute('content', brandShortName(branding.appName, branding.shortName));
}

/** Calls `onChange` when the page switches between light and dark; returns the way to stop. */
export function watchAppliedMode(onChange: () => void, root: Document = document): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(root.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

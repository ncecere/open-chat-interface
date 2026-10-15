import { type AnyRouter, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStatus } from '~/hooks/use-auth-status';
import {
  applyBrandIcons,
  brandIconHref,
  documentTitle,
  pageTitleFor,
  usePageTitleOverride,
} from '~/lib/document-title';
import { applyInstallMeta, watchAppliedMode } from '~/lib/install-meta';

/**
 * Keeps the tab title and icon in step with Branding and the current page.
 *
 * Mounted beside the router rather than inside a route, so it covers the
 * sign-in and public share pages too (`/auth/status` is public). Renders
 * nothing. Until the status arrives the title is the product's name, as
 * index.html serves it.
 */
export function DocumentBranding({ router }: { router: AnyRouter }) {
  const { data } = useAuthStatus();
  const pathname = useRouterState({ router, select: (state) => state.location.pathname });
  const override = usePageTitleOverride();
  const appName = data?.branding?.appName;
  const icon = brandIconHref(data?.branding?.logoUrl);

  useEffect(() => {
    document.title = documentTitle(override ?? pageTitleFor(pathname), appName);
  }, [appName, override, pathname]);

  useEffect(() => {
    // Wait for the status: resetting to the default first would flash it.
    if (data) applyBrandIcons(icon);
  }, [data, icon]);

  // The install metadata (#400): the browser's bar colour and the home-screen
  // title. The bar follows the mode the page is in, so it is set again when
  // the person switches between light and dark.
  const colorTheme = data?.branding?.colorTheme;
  const shortName = data?.branding?.shortName;
  useEffect(() => {
    if (!data) return;
    const apply = () => applyInstallMeta({ appName, shortName, colorTheme });
    apply();
    return watchAppliedMode(apply);
  }, [data, appName, shortName, colorTheme]);

  return null;
}

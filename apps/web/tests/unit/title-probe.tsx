import { useRouterState } from '@tanstack/react-router';
import { documentTitle, pageTitleFor, usePageTitleOverride } from '../../src/lib/document-title';

/**
 * The tab title DocumentBranding would set for the current page, written to
 * `data-title` (#197): the page's own title if it named itself, else the
 * path's name, then the instance's.
 */
export function TitleProbe() {
  const override = usePageTitleOverride();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <output data-title={documentTitle(override ?? pageTitleFor(pathname), 'Acme')} />;
}

export const shownTitle = () =>
  document.querySelector('output[data-title]')?.getAttribute('data-title');

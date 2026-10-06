import { Link, useRouterState } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { usePageTitle } from '~/lib/document-title';

/**
 * An address with no page, in the layout every unavailable page uses (#131).
 * The router's default was the bare text "Not Found", with no heading,
 * explanation or way back.
 */
export function NotFoundPage({ admin = false }: { admin?: boolean }) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  usePageTitle('Page not found');
  return (
    <UnavailableState
      title="Page not found"
      actions={
        <Button asChild>
          {admin ? <Link to="/admin">Go to Overview</Link> : <Link to="/">New chat</Link>}
        </Button>
      }
    >
      {admin
        ? `There is no administration page at ${path}. Choose a page from the menu, or start from the overview.`
        : `There is no page at ${path}. Check the address, or start a new chat.`}
    </UnavailableState>
  );
}

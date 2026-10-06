import { Link, useRouterState } from '@tanstack/react-router';
import { Button } from '~/components/ui/button';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useCurrentUser } from '~/hooks/use-current-user';

/**
 * An address with no page, in the layout every unavailable page uses (#131).
 * The router's default was the bare text "Not Found", with no heading,
 * explanation or way back.
 *
 * Outside every layout the visitor may not be signed in, and "New chat" only
 * led to sign-in: someone signed out is offered Sign in instead (#197).
 */
export function NotFoundPage({ admin = false }: { admin?: boolean }) {
  const path = useRouterState({ select: (state) => state.location.pathname });
  // Signed in inside the admin and the chat shell; /me answers null when not.
  const { data: me } = useCurrentUser();
  const signedOut = !admin && me === null;
  // The router marks a link active, with aria-current="page", when the address
  // starts with its target: /admin for every admin address, / for every
  // address. Only an exact match is this page, and here none ever is (#273).
  const exact = { exact: true };
  return (
    <UnavailableState
      title="Page not found"
      actions={
        <Button asChild>
          {admin ? (
            <Link to="/admin" activeOptions={exact}>
              Go to Overview
            </Link>
          ) : signedOut ? (
            <Link to="/auth/login" activeOptions={exact}>
              Sign in
            </Link>
          ) : (
            <Link to="/" activeOptions={exact}>
              New chat
            </Link>
          )}
        </Button>
      }
    >
      {admin
        ? `There is no administration page at ${path}. Choose a page from the menu, or start from the overview.`
        : signedOut
          ? `There is no page at ${path}. Check the address, or sign in.`
          : `There is no page at ${path}. Check the address, or start a new chat.`}
    </UnavailableState>
  );
}

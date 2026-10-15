import { passkeyClient } from '@better-auth/passkey/client';
import { ssoClient } from '@better-auth/sso/client';
import { adminClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { noteSigningOut } from '~/lib/session-ended';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  // twoFactorClient has no `onTwoFactorRedirect`: the sign-in page reads
  // `twoFactorRedirect` from the response itself and goes to its own route.
  plugins: [adminClient(), ssoClient(), twoFactorClient(), passkeyClient()],
  fetchOptions: {
    // Signing out on purpose is not a session that ended under the person
    // (#165): the requests that follow it are refused as expected.
    onRequest: (context) => {
      if (new URL(String(context.url), window.location.origin).pathname.endsWith('/sign-out'))
        noteSigningOut();
    },
  },
});

export const { signIn, signOut, signUp, useSession } = authClient;

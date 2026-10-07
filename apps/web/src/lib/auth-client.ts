import { ssoClient } from '@better-auth/sso/client';
import { adminClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { noteSigningOut } from '~/lib/session-ended';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient(), ssoClient()],
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

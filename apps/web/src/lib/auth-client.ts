import { ssoClient } from '@better-auth/sso/client';
import { adminClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [adminClient(), ssoClient()],
});

export const { signIn, signOut, signUp, useSession } = authClient;

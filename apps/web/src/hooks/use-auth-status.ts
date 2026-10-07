import type { AuthStatus } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

/** Public login-screen configuration: enabled methods and branding. */
export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get<AuthStatus>('/auth/status'),
    staleTime: 60_000,
    retry: 1,
    // While it cannot be loaded (the database or the API down, #288), asked
    // again every 5 s, so the auth pages recover by themselves once it is back.
    refetchInterval: (query) => (query.state.status === 'error' ? 5_000 : false),
  });
}

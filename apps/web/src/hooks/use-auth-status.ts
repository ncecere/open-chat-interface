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
  });
}

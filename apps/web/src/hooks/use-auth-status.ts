import type { AuthStatus } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

/** Public login-screen configuration: enabled methods and branding. */
export function useAuthStatus() {
  const query = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get<AuthStatus>('/auth/status'),
    staleTime: 60_000,
    retry: 1,
    // While it cannot be loaded (the database or the API down, #288), asked
    // again every 5 s, so the auth pages recover by themselves once it is back.
    refetchInterval: (query) => (query.state.status === 'error' ? 5_000 : false),
  });
  // A query with no data goes back to `pending` (its error cleared) for every
  // refetch, so `isError` and `isLoading` flipped with each 5 s check: Forgot
  // password swapped its "temporarily unavailable" card, Try again included,
  // for a bare spinner while each check was out, which in an outage where a
  // check takes 15 s to fail was most of the time (#307), and sign-in and
  // sign-up dropped their forms. A failure is remembered until an answer
  // comes (`errorUpdateCount` survives the reset), so the spinner is only for
  // the first load.
  const unavailable = query.data === undefined && (query.isError || query.errorUpdateCount > 0);
  return {
    ...query,
    /** No status yet, and it has failed: an outage, still being checked. */
    unavailable,
    /** The first load: no status yet and no failure so far. */
    firstLoad: query.data === undefined && !unavailable,
  };
}

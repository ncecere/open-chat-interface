import type { SetupCheck, SetupCheckId, SetupStatus } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

export const SETUP_STATUS_QUERY_KEY = ['admin', 'setup-status'] as const;

/**
 * The administrator setup checklist, computed by the server from stored
 * configuration. Pages that change configuration should invalidate
 * `SETUP_STATUS_QUERY_KEY` so the checklist and contextual notices update.
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: () => api.get<SetupStatus>('/admin/setup-status'),
  });
}

/** One check, for a contextual notice on the page that resolves it. */
export function useSetupCheck(id: SetupCheckId): SetupCheck | undefined {
  return useSetupStatus().data?.checks.find((check) => check.id === id);
}

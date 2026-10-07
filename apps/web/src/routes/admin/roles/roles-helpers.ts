import type { UserRole } from '@oci/shared';
import type { QueryClient } from '@tanstack/react-query';
import { CONFIG_SOURCES_QUERY_KEY } from '~/components/admin/config-source';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';

export const ROLES_QUERY_KEY = ['admin', 'roles'] as const;

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  user: 'User',
  restricted: 'Restricted',
};

export function isWholeNumberIn(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/** Everything this page summarises can change after any write it makes. */
export function invalidateAccess(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ROLES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'rate-limits'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'storage-policies'] }),
    queryClient.invalidateQueries({ queryKey: CONFIG_SOURCES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
    // A role's features and reasoning levels shape the composer, including
    // the administrator's own.
    queryClient.invalidateQueries({ queryKey: ['me'] }),
    queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
  ]);
}

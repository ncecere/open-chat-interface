import type { AdminClassification } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

/** The mode, the services' approvals and what is needed to turn it on (`GET /admin/classification`). */
export const ADMIN_CLASSIFICATION_KEY = ['admin', 'classification'] as const;

export function useAdminClassification() {
  return useQuery({
    queryKey: ADMIN_CLASSIFICATION_KEY,
    queryFn: () => api.get<AdminClassification>('/admin/classification'),
  });
}

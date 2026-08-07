import type { CatalogModel } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

/** Models the signed-in user is permitted to select. */
export function useModels() {
  return useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => api.get<{ models: CatalogModel[] }>('/models'),
    staleTime: 60_000,
    select: (data) => data.models,
  });
}

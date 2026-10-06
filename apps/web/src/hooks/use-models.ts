import type { CatalogModel } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

interface ModelCatalogResponse {
  models: CatalogModel[];
  /** None is visible to this person's role, though the instance has some (#303). */
  hiddenFromRole?: boolean;
}

const fetchCatalog = () => api.get<ModelCatalogResponse>('/models');

/** Models the signed-in user is permitted to select. */
export function useModels() {
  return useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: fetchCatalog,
    staleTime: 60_000,
    select: (data) => data.models,
  });
}

/**
 * Whether the person sees no models because of their role, while the
 * instance has some: they are told to ask an administrator, not that the
 * instance is not set up (#303). The same request as useModels.
 */
export function useModelsHiddenFromRole(): boolean {
  const { data } = useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: fetchCatalog,
    staleTime: 60_000,
    select: (response) => response.hiddenFromRole === true,
  });
  return data ?? false;
}

import type { Persona } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '~/lib/api-client';

export interface PersonaInput {
  name: string;
  icon?: string | null;
  systemPrompt: string;
  traits: string[];
  isDefault?: boolean;
}

export function usePersonas(enabled = true) {
  return useQuery({
    queryKey: ['personas'],
    queryFn: () => api.get<{ personas: Persona[] }>('/me/personas'),
    select: (data) => data.personas,
    enabled,
  });
}

export function useCreatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonaInput) => api.post<{ persona: Persona }>('/me/personas', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['personas'] }),
  });
}

export function useUpdatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<PersonaInput>) =>
      api.patch<{ persona: Persona }>(`/me/personas/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['personas'] }),
  });
}

export function useDeletePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/me/personas/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['personas'] }),
  });
}

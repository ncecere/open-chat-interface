import type { UserRole } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '~/lib/api-client';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  role: UserRole;
  emailVerified: boolean;
}

export interface UserPreferences {
  theme: string;
  boringMode: boolean;
  mainFont: string;
  codeFont: string;
  density: string;
  displayName: string | null;
  occupation: string | null;
  traits: string[];
  additionalContext: string | null;
  defaultModelSlug: string | null;
}

export interface CurrentFeatures {
  shareLinks: boolean;
  temporaryChat: boolean;
  canvas: boolean;
  mcp: boolean;
  webSearch: boolean;
  attachments: boolean;
  branching: boolean;
}

interface MeResponse {
  user: CurrentUser;
  preferences: UserPreferences;
  features: CurrentFeatures;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<MeResponse>('/me');
      } catch (error) {
        // Anonymous visitors are a normal state, not an error.
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}

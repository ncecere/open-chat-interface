import type { ReasoningEffort, UserRole } from '@oci/shared';
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
  mainFont: string;
  codeFont: string;
  density: string;
  displayName: string | null;
  occupation: string | null;
  traits: string[];
  additionalContext: string | null;
  defaultModelSlug: string | null;
  /** The person's own memory switch; absent from an API before v0.9. */
  memoryEnabled?: boolean;
}

export interface CurrentFeatures {
  shareLinks: boolean;
  temporaryChat: boolean;
  webSearch: boolean;
  attachments: boolean;
  branching: boolean;
  /** Decided by the role alone; projects have no instance-wide switch. */
  projects: boolean;
  /**
   * User memory is offered: the instance and the role allow it. The person
   * still switches it on in Settings → Memory. Absent before v0.9.
   */
  memory?: boolean;
}

interface CurrentChatDefaults {
  /** The administrator's starting level, before clamping to the model. */
  defaultEffort: ReasoningEffort;
  /** Levels this person's role may choose. */
  reasoningEfforts: ReasoningEffort[];
}

interface MeResponse {
  user: CurrentUser;
  preferences: UserPreferences;
  /** Instance switches narrowed by the person's role. */
  features: CurrentFeatures;
  /** Optional so a response from an older API still renders. */
  chat?: CurrentChatDefaults;
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

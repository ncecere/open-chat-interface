import type { PersonalDefaultProblem, ReasoningEffort, SignInMethods, UserRole } from '@oci/shared';
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
  /** The person's own starting model (Settings → Models); null for the instance default. */
  defaultModelSlug: string | null;
  /** The person's own starting reasoning level (v0.10); null or absent for the instance default. */
  defaultEffort?: ReasoningEffort | null;
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
  /** Decided by the role alone (v0.9). Optional so an older API's response still renders. */
  artifacts?: boolean;
  /** The person may delete their own account (v0.10); decided by the role, off by default. */
  accountDeletion?: boolean;
}

interface CurrentChatDefaults {
  /**
   * Where the composer's level starts, before clamping to the model: the
   * person's own default when it still applies (v0.10), else the instance's.
   */
  defaultEffort: ReasoningEffort;
  /** Levels this person's role may choose. */
  reasoningEfforts: ReasoningEffort[];
  /** The administrator's level (v0.10; absent from an older API). */
  instanceDefaultEffort?: ReasoningEffort;
  /** The person's own model while it is available to them (v0.10); null for the catalog default. */
  defaultModelSlug?: string | null;
  /** Saved defaults that no longer apply and are ignored (v0.10). */
  defaultProblems?: PersonalDefaultProblem[];
}

/** What Settings needs to hide sections with nothing in them (v0.9.1). */
export interface SettingsSummary {
  memoryEntries: number;
  /** Connectors the person's role could connect to. */
  connectors: number;
  /** Share links not yet revoked (v0.10); absent from an older API. */
  shareLinks?: number;
}

interface MeResponse {
  user: CurrentUser;
  preferences: UserPreferences;
  /** How the person signs in (v0.9.1); absent from an older API. */
  signIn?: SignInMethods;
  /** Absent from an older API; every section then shows. */
  settingsSummary?: SettingsSummary;
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
    // A signed-in answer is reused for 30 s; an anonymous one never is. Signing
    // out refetches /me while the app is still mounted, and a cached `null`
    // that counted as fresh was handed to the next account to sign in.
    staleTime: (query) => (query.state.data === null ? 0 : 30_000),
    retry: false,
  });
}

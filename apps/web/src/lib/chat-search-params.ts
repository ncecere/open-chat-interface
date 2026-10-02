interface ChatThreadSearch {
  /** A message to open at instead of the end, set by conversation search. */
  message?: string;
}

/** Message ids are generated UUIDs; anything else in the URL is ignored. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validateChatThreadSearch(search: Record<string, unknown>): ChatThreadSearch {
  const message = search.message;
  return typeof message === 'string' && MESSAGE_ID.test(message) ? { message } : {};
}

interface ChatHomeSearch {
  /** Start the new conversation inside this project. */
  project?: string;
}

/** Project ids are generated UUIDs; anything else is ignored. */
export function validateChatHomeSearch(search: Record<string, unknown>): ChatHomeSearch {
  const project = search.project;
  return typeof project === 'string' && MESSAGE_ID.test(project) ? { project } : {};
}

export const PROJECT_TABS = ['conversations', 'instructions', 'files', 'settings'] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];
export const DEFAULT_PROJECT_TAB: ProjectTab = 'conversations';

interface ProjectSearch {
  /** The open tab; the default is left out of the URL. */
  tab?: ProjectTab;
}

export function validateProjectSearch(search: Record<string, unknown>): ProjectSearch {
  const tab = PROJECT_TABS.find((candidate) => candidate === search.tab);
  return tab && tab !== DEFAULT_PROJECT_TAB ? { tab } : {};
}

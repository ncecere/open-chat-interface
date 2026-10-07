/**
 * A conversation this tab removed as it closed or reloaded because it was
 * never used (#266), so the page that loads next in the same tab opens a new
 * chat with the unsent text instead of a conversation that is gone. Session
 * storage: it belongs to this tab and goes with it.
 */
const REMOVED_KEY = 'oci.removedUnusedConversation';
/** The unsent text, for the new-chat page's composer. */
const RESTORED_DRAFT_KEY = 'oci.restoredDraft';

export interface RemovedConversation {
  threadId: string;
  /** The project it was started in, so the new chat starts there too. */
  projectId: string | null;
  draft: string;
}

export function noteRemovedConversation(removed: RemovedConversation): void {
  try {
    sessionStorage.setItem(REMOVED_KEY, JSON.stringify(removed));
  } catch {
    // Storage full or blocked: the reload shows "unavailable" instead.
  }
}

/** Set when a reload lands on the removed conversation: see takeRemovalToConfirm. */
let toConfirm: string | null = null;

function read(): Partial<RemovedConversation> | null {
  try {
    const raw = sessionStorage.getItem(REMOVED_KEY);
    return raw ? (JSON.parse(raw) as Partial<RemovedConversation>) : null;
  } catch {
    return null;
  }
}

/** Whether `threadId` is the conversation this tab removed. */
export function removedConversation(threadId: string): boolean {
  return read()?.threadId === threadId;
}

/**
 * Whether `threadId` is the conversation this tab removed. When it is, the
 * note is used up and its text kept for takeRestoredDraft.
 */
export function takeRemovedConversation(threadId: string): RemovedConversation | null {
  const value = read();
  if (value?.threadId !== threadId) return null;
  try {
    sessionStorage.removeItem(REMOVED_KEY);
    toConfirm = threadId;
    const draft = typeof value.draft === 'string' ? value.draft : '';
    if (draft) sessionStorage.setItem(RESTORED_DRAFT_KEY, draft);
    return {
      threadId,
      projectId: typeof value.projectId === 'string' ? value.projectId : null,
      draft,
    };
  } catch {
    return null;
  }
}

/**
 * The conversation a reload has just turned away from, once: the request that
 * removed it was sent as the old page closed, and may arrive after this page
 * has listed conversations, or not at all, so the new page asks again.
 */
export function takeRemovalToConfirm(): string | null {
  const threadId = toConfirm;
  toConfirm = null;
  return threadId;
}

/**
 * The text of a removed conversation's refused message, for the new chat
 * opened in its place. Read during render, so it is cleared separately (in an
 * effect): Strict Mode runs a state initializer twice.
 */
export function peekRestoredDraft(): string {
  try {
    return sessionStorage.getItem(RESTORED_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearRestoredDraft(): void {
  try {
    sessionStorage.removeItem(RESTORED_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

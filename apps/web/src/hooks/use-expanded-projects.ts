import { MAX_PROJECTS_PER_USER } from '@oci/shared';
import { useCallback, useEffect, useState } from 'react';

/** One key for every project: the ids of those left open, as a JSON array. */
export const EXPANDED_PROJECTS_STORAGE_KEY = 'oci.sidebar.expandedProjects';

function readExpanded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(stored)) return new Set();
    return new Set(
      stored.filter((id): id is string => typeof id === 'string').slice(0, MAX_PROJECTS_PER_USER),
    );
  } catch {
    // Unreadable or blocked storage: everything starts collapsed.
    return new Set();
  }
}

function writeExpanded(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage full or blocked: the choice lasts for this page only.
  }
}

/**
 * Which sidebar projects are open, remembered per browser. Everything starts
 * collapsed. Ids of deleted projects (or another account's, on a shared
 * browser) are harmless: they match nothing, and are dropped the next time
 * the choice is saved while the project list is known.
 *
 * Open tabs follow each other (v0.10): opening or closing a project in one tab
 * changes it in every other tab of the same browser. The browser's `storage`
 * event fires only in the other tabs, never the one that wrote, and a cleared
 * storage (`key` null) collapses everything.
 */
export function useExpandedProjects(projects: ReadonlyArray<{ id: string }> | undefined) {
  const [expanded, setExpanded] = useState(readExpanded);

  useEffect(() => {
    const follow = (event: StorageEvent) => {
      // Session storage changes in this tab are not another tab's choice.
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.key !== null && event.key !== EXPANDED_PROJECTS_STORAGE_KEY) return;
      setExpanded(readExpanded());
    };
    window.addEventListener('storage', follow);
    return () => window.removeEventListener('storage', follow);
  }, []);

  const toggle = useCallback(
    (id: string, open: boolean) => {
      const next = new Set(expanded);
      if (open) next.add(id);
      else next.delete(id);
      if (projects) {
        const known = new Set(projects.map((project) => project.id));
        for (const stale of [...next].filter((candidate) => !known.has(candidate))) {
          next.delete(stale);
        }
      }
      writeExpanded(next);
      setExpanded(next);
    },
    [expanded, projects],
  );

  return { expanded, toggle };
}

import { MODEL_LABS } from './catalog.js';
import type { ModelLab } from './types.js';

const LABS_BY_ID = new Map(MODEL_LABS.map((lab) => [lab.id, lab]));

export function findModelLab(id: string | null | undefined): ModelLab | null {
  return id ? (LABS_BY_ID.get(id) ?? null) : null;
}

/** Resolves the public URL for a lab mark in the active theme. */
export function modelLabLogoUrl(lab: ModelLab, mode: 'light' | 'dark'): string {
  return `/logos/${mode === 'dark' ? lab.dark : lab.light}`;
}

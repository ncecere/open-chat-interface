import type { MemoryState } from '@oci/shared';
import { api } from '~/lib/api-client';

/** Settings → Memory and the "Memory updated" note share this query. */
export const MEMORY_QUERY_KEY = ['memory'] as const;

export const fetchMemory = () => api.get<MemoryState>('/memory');

/** Reverses one `remember` or `forget` step of the person's own reply. */
export const undoMemoryStep = (messageId: string, toolCallId: string) =>
  api.post<{ action: 'removed' | 'restored'; changed: boolean }>('/memory/undo', {
    messageId,
    toolCallId,
  });

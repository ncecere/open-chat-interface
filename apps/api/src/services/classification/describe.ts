import type { ClassificationResponse, UserRole } from '@oci/shared';
import { getOwnedProject } from '../projects.js';
import { getOwnedThread } from '../threads.js';
import { classificationMode } from './config.js';
import { loadClasses } from './resolve.js';
import { modelStatuses, toClassificationClass } from './view.js';

/** `GET /api/classification`: the person's own conversation or project, never anyone else's. */
export async function describeClassification(input: {
  userId: string;
  role: UserRole;
  threadId?: string | undefined;
  projectId?: string | undefined;
}): Promise<ClassificationResponse> {
  const mode = await classificationMode();
  // 404 for another person's conversation or project even with the feature off.
  if (input.threadId) await getOwnedThread(input.threadId, input.userId);
  else if (input.projectId) await getOwnedProject(input.projectId, input.userId);
  if (mode === 'off') return { mode, classes: [], models: [] };
  const classes = await loadClasses({
    ...(input.threadId ? { threadId: input.threadId } : { projectId: input.projectId }),
  });
  return {
    mode,
    classes: classes.map(toClassificationClass),
    models: await modelStatuses({ userId: input.userId, role: input.role }, classes, mode),
  };
}

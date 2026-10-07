import { z } from 'zod';
import { attachmentSchema, threadSummarySchema } from './chat.js';

/**
 * Projects group conversations under shared instructions and files.
 *
 * The limits are application constants rather than settings: they bound how
 * much a single project can add to every turn's context and how many rows a
 * sidebar has to render, not how much storage someone may use (storage
 * allowances already cover that).
 */
export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 8000;
export const MAX_PROJECTS_PER_USER = 100;
export const MAX_FILES_PER_PROJECT = 20;
/** Recent conversations the sidebar lists under each project (v0.9.1). */
export const SIDEBAR_PROJECT_THREAD_LIMIT = 5;

const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the project a name.')
  .max(
    PROJECT_NAME_MAX_LENGTH,
    `Project names can be at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
  );

const projectInstructionsSchema = z
  .string()
  .max(
    PROJECT_INSTRUCTIONS_MAX_LENGTH,
    `Instructions can be at most ${PROJECT_INSTRUCTIONS_MAX_LENGTH} characters.`,
  );

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    instructions: projectInstructionsSchema.default(''),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    instructions: projectInstructionsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one change.' });

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** Ready files; uploads still in progress are not counted. */
  fileCount: z.number().int().nonnegative(),
  /** Live conversations (not archived, trashed or temporary). */
  threadCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * One project in the sidebar's tree (`GET /api/projects/sidebar`, v0.9.1).
 * `recentThreads` are the newest live conversations that are not pinned, at
 * most SIDEBAR_PROJECT_THREAD_LIMIT, newest first: pinned ones are listed
 * only in the sidebar's Pinned section. `threadCount` counts every live
 * conversation in the project, pinned ones included.
 */
export const sidebarProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  threadCount: z.number().int().nonnegative(),
  recentThreads: z.array(threadSummarySchema),
});

/**
 * Whether a project file can be searched when a project is too large to give
 * the model whole. `pending` files are waiting for the background indexing
 * job and are used whole meanwhile, as far as they fit; `no-text` files (such
 * as images) have nothing to search and are always used whole.
 */
export const projectFileIndexSchema = z.object({
  status: z.enum(['indexed', 'pending', 'no-text']),
  /** Searchable passages the file was split into. */
  passages: z.number().int().nonnegative(),
  /**
   * The file was longer than one file's passage limit, so only its start is
   * searchable. Absent from an older API, which reads as false.
   */
  truncated: z.boolean().optional(),
});

/** A project file is an attachment owned by the project rather than a message. */
export const projectFileSchema = attachmentSchema.extend({ index: projectFileIndexSchema });

/** Characters of a passage kept in a reply's project-search note (v0.10). */
export const PROJECT_EXCERPT_MAX_CHARS = 200;
/** Passages listed in one reply's project-search note (v0.10); the rest are only counted. */
export const PROJECT_EXCERPTS_MAX = 24;

const projectSearchExcerptSchema = z.object({
  /** Stable within the reply: the file's id and the passage numbers. */
  id: z.string().max(300),
  /** 1-based passage numbers of the first and last chunk, as the model saw them. */
  first: z.number().int().positive(),
  last: z.number().int().positive(),
  heading: z.string().max(200).optional(),
  /** Ends with an ellipsis when the passage was longer. */
  snippet: z.string().max(PROJECT_EXCERPT_MAX_CHARS + 1),
});

/**
 * The `data-project-search` part on a reply whose project files were too large
 * to include whole, so passages were chosen instead. It names the files used
 * and how many passages came from each. Since v0.10 each file also lists its
 * passages (`excerpts`): an id, the passage numbers, the nearest heading when
 * the passage has one, and only the first PROJECT_EXCERPT_MAX_CHARS characters
 * of its text, at most PROJECT_EXCERPTS_MAX per reply; older replies have no
 * excerpts. `excluded` (v0.10) names the files the person left out of this
 * message; with exclusions and no searched passages, `files` is empty.
 * The part is never shown on shared links. `mode` is `search` when passages
 * matched the message.
 * `opening` is only on replies stored before v0.9's relevance floors, when
 * nothing matched and each file's opening passages were used; now a reply
 * that used no passages has no part at all.
 * `ranking` (v0.9) says how searched passages were ranked: `hybrid` when
 * meaning-based (vector) results were merged with keyword results, `keyword`
 * otherwise. Absent on replies from before v0.9, which were keyword-only.
 * `reranked` (v0.9) is present only when a reranking model is configured:
 * `true` when it reordered the candidates, `false` when it could not and the
 * previous order was used.
 */
export const projectSearchDataSchema = z.object({
  mode: z.enum(['search', 'opening']),
  ranking: z.enum(['hybrid', 'keyword']).optional(),
  reranked: z.boolean().optional(),
  files: z.array(
    z.object({
      name: z.string(),
      passages: z.number().int().positive(),
      excerpts: z.array(projectSearchExcerptSchema).max(PROJECT_EXCERPTS_MAX).optional(),
    }),
  ),
  excluded: z
    .array(z.object({ name: z.string() }))
    .max(MAX_FILES_PER_PROJECT)
    .optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type SidebarProject = z.infer<typeof sidebarProjectSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileIndex = z.infer<typeof projectFileIndexSchema>;
export type ProjectSearchData = z.infer<typeof projectSearchDataSchema>;

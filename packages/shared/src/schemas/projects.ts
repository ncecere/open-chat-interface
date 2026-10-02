import { z } from 'zod';
import { attachmentSchema } from './chat.js';

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
 * Whether a project file can be searched when a project is too large to give
 * the model whole. `pending` files are waiting for the background indexing
 * job and are used whole meanwhile, as far as they fit; `no-text` files (such
 * as images) have nothing to search and are always used whole.
 */
export const projectFileIndexSchema = z.object({
  status: z.enum(['indexed', 'pending', 'no-text']),
  /** Searchable passages the file was split into. */
  passages: z.number().int().nonnegative(),
});

/** A project file is an attachment owned by the project rather than a message. */
export const projectFileSchema = attachmentSchema.extend({ index: projectFileIndexSchema });

/**
 * The `data-project-search` part on a reply whose project files were too large
 * to include whole, so passages were chosen instead. It names the files used
 * and how many passages came from each, never the passage text, so it is safe
 * in exports. `mode` is `search` when passages matched the message and
 * `opening` when nothing matched and each file's opening passages were used.
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
    }),
  ),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileIndex = z.infer<typeof projectFileIndexSchema>;
export type ProjectSearchData = z.infer<typeof projectSearchDataSchema>;

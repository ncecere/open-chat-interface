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

/** A project file is an attachment owned by the project rather than a message. */
export const projectFileSchema = attachmentSchema;

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;

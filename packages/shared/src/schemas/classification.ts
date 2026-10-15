import { z } from 'zod';
import { patchSchema } from './patch.js';

/**
 * Data classification (v0.14, #395): administrators define named data classes,
 * approve models and a few outside services per class, and say which classes a
 * connector carries. A conversation's classes come from its project, the
 * connectors it has used and labels a person adds. OCI refuses (or, in `warn`,
 * notes) a send that would carry a class to something not approved for it.
 * See docs/admin/data-classification.md.
 */

/** `off` is the default and changes nothing; `warn` is a dry run of `block`. */
export const CLASSIFICATION_MODES = ['off', 'warn', 'block'] as const;
export type ClassificationMode = (typeof CLASSIFICATION_MODES)[number];

/** Outside services whose approvals live in the instance setting, not on a model. */
export const CLASSIFICATION_SERVICES = ['webSearch', 'embeddings', 'reranking'] as const;
export type ClassificationService = (typeof CLASSIFICATION_SERVICES)[number];

/**
 * Where a refusal happened, as `DATA_CLASS_BLOCKED` reports it. Tools,
 * searches and embeddings are withheld quietly (the model is told the tool is
 * unavailable), so only these four ever return an error body.
 */
export const CLASSIFICATION_BLOCK_POINTS = ['send', 'approval', 'compaction', 'share'] as const;
export type ClassificationBlockPoint = (typeof CLASSIFICATION_BLOCK_POINTS)[number];

/** Every place a decision is counted and audited (`oci_classification_decisions_total`). */
export const CLASSIFICATION_POINTS = [
  'send',
  'approval',
  'tool',
  'compaction',
  'web_search',
  'embedding',
  'rerank',
  'share',
] as const;
export type ClassificationPoint = (typeof CLASSIFICATION_POINTS)[number];

/** Why a conversation carries a class (a class can have several reasons). */
export const CLASSIFICATION_REASONS = ['project', 'connector', 'person', 'kept'] as const;
export type ClassificationReason = (typeof CLASSIFICATION_REASONS)[number];

export const DATA_CLASS_NAME_MAX_LENGTH = 60;
export const DATA_CLASS_DESCRIPTION_MAX_LENGTH = 280;
/** Most classes one instance defines; a pick list, not a taxonomy. */
export const MAX_DATA_CLASSES = 100;

/** A class as a person sees it in a picker: name only. */
export const dataClassSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type DataClass = z.infer<typeof dataClassSchema>;

/** `GET /api/data-classes`: classes that can still be added as a label. */
export const dataClassListSchema = z.object({ classes: z.array(dataClassSchema) });
export type DataClassList = z.infer<typeof dataClassListSchema>;

/** A class as administrators see it, with where it is used. */
export const adminDataClassSchema = dataClassSchema.extend({
  description: z.string(),
  /** Retired classes are hidden from pickers and refuse new labels; they still count. */
  retiredAt: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  connectorCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  threadCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminDataClass = z.infer<typeof adminDataClassSchema>;

const dataClassNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the class a name.')
  .max(
    DATA_CLASS_NAME_MAX_LENGTH,
    `Class names can be at most ${DATA_CLASS_NAME_MAX_LENGTH} characters.`,
  );

const dataClassDescriptionSchema = z
  .string()
  .trim()
  .max(
    DATA_CLASS_DESCRIPTION_MAX_LENGTH,
    `Descriptions can be at most ${DATA_CLASS_DESCRIPTION_MAX_LENGTH} characters.`,
  );

/** Body of `POST /admin/data-classes`. */
export const createDataClassSchema = z
  .object({
    name: dataClassNameSchema,
    description: dataClassDescriptionSchema.default(''),
  })
  .strict();
export type CreateDataClassInput = z.infer<typeof createDataClassSchema>;

/** Body of `PATCH /admin/data-classes/:id` (a rename keeps the id, so labels follow). */
export const updateDataClassSchema = patchSchema(
  z.object({ name: dataClassNameSchema, description: dataClassDescriptionSchema }),
)
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one change.' });
export type UpdateDataClassInput = z.infer<typeof updateDataClassSchema>;

/**
 * `409` body details when a class is still referenced: how many of each, so
 * the administrator can see why it cannot be deleted.
 */
export const dataClassInUseDetailsSchema = z.object({
  connectors: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
});
export type DataClassInUseDetails = z.infer<typeof dataClassInUseDetailsSchema>;

/** Body of the `PUT .../data-classes` routes that replace a whole list of classes. */
export const setDataClassIdsSchema = z
  .object({ classIds: z.array(z.string().min(1).max(200)).max(MAX_DATA_CLASSES) })
  .strict();
export type SetDataClassIdsInput = z.infer<typeof setDataClassIdsSchema>;

/**
 * Body of `PUT /admin/connectors/:id/data-classes`: the classes the connector
 * carries. `reviewed: true` with an empty list says "carries no classified
 * data" on purpose; with the mode on, a new connector must say one or the other.
 */
export const setConnectorDataClassesSchema = setDataClassIdsSchema
  .extend({ reviewed: z.boolean() })
  .strict();
export type SetConnectorDataClassesInput = z.infer<typeof setConnectorDataClassesSchema>;

/** Body of `POST /api/threads/:id/data-classes`. */
export const addThreadDataClassSchema = z.object({ classId: z.string().min(1).max(200) }).strict();
export type AddThreadDataClassInput = z.infer<typeof addThreadDataClassSchema>;

/** The instance setting `classification`. Absent means `off` with no approvals. */
export const classificationSettingsSchema = z.object({
  mode: z.enum(CLASSIFICATION_MODES),
  /** Class ids each outside service may receive; default none. */
  services: z.object({
    webSearch: z.array(z.string()),
    embeddings: z.array(z.string()),
    reranking: z.array(z.string()),
  }),
});
export type ClassificationSettings = z.infer<typeof classificationSettingsSchema>;

/**
 * `GET /admin/classification`: the setting plus what an administrator needs
 * to turn it on safely.
 */
export const adminClassificationSchema = classificationSettingsSchema.extend({
  /**
   * Whether the background migration that finds earlier connector use has
   * been scheduled (`migrate --post`). `warn` and `block` are refused (409)
   * until it has: before that a v0.13 replica may still be running.
   */
  modeAvailable: z.boolean(),
  /** Whether that background migration has finished (the fallback scan is off). */
  backfillDone: z.boolean(),
  /** Connectors with no review recorded (the "Not reviewed" badge). */
  unreviewedConnectorCount: z.number().int().nonnegative(),
});
export type AdminClassification = z.infer<typeof adminClassificationSchema>;

/** Body of `PATCH /admin/classification`: only sent fields change. */
export const updateClassificationSettingsSchema = z
  .object({
    mode: z.enum(CLASSIFICATION_MODES).optional(),
    services: z
      .object({
        webSearch: z.array(z.string().min(1).max(200)).max(MAX_DATA_CLASSES).optional(),
        embeddings: z.array(z.string().min(1).max(200)).max(MAX_DATA_CLASSES).optional(),
        reranking: z.array(z.string().min(1).max(200)).max(MAX_DATA_CLASSES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one change.' });
export type UpdateClassificationSettingsInput = z.infer<typeof updateClassificationSettingsSchema>;

/** A class a conversation or project carries, with why (for the chips). */
export const classificationClassSchema = dataClassSchema.extend({
  reasons: z.array(z.enum(CLASSIFICATION_REASONS)),
  /**
   * A project label an administrator set: only an administrator removes it.
   * Present on a project's classes.
   */
  locked: z.boolean().optional(),
  /** Whether the person can remove this label (only labels they added). */
  removable: z.boolean().optional(),
  /** Retired classes still count but cannot be newly added. */
  retired: z.boolean().optional(),
  /** For a connector reason: the connector's name, for "from the SIS connector". */
  connectorNames: z.array(z.string()).optional(),
  /** For a `kept` label: where it came from ("project", "connector: name"). */
  origins: z.array(z.string()).optional(),
});
export type ClassificationClass = z.infer<typeof classificationClassSchema>;

export const CLASSIFICATION_MODEL_STATUSES = ['ok', 'warn', 'blocked'] as const;
export type ClassificationModelStatus = (typeof CLASSIFICATION_MODEL_STATUSES)[number];

/** One model as the picker needs it: can it take this conversation? */
export const classificationModelSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  status: z.enum(CLASSIFICATION_MODEL_STATUSES),
  /** Classes the conversation carries that the model is not approved for. */
  missing: z.array(dataClassSchema),
});
export type ClassificationModel = z.infer<typeof classificationModelSchema>;

/**
 * `GET /api/classification?threadId=` or `?projectId=`: computed on the
 * server so the client does no set arithmetic. In mode `off` it is
 * `{ mode: 'off', classes: [], models: [] }` and nothing else is read.
 */
export const classificationResponseSchema = z.object({
  mode: z.enum(CLASSIFICATION_MODES),
  classes: z.array(classificationClassSchema),
  models: z.array(classificationModelSchema),
});
export type ClassificationResponse = z.infer<typeof classificationResponseSchema>;

/** A thread's labels in `ThreadSummary.dataClasses`. */
export const threadDataClassSchema = dataClassSchema.extend({
  reasons: z.array(z.enum(CLASSIFICATION_REASONS)),
});
export type ThreadDataClass = z.infer<typeof threadDataClassSchema>;

/**
 * `error.details` of a `DATA_CLASS_BLOCKED` (403) response. The error's
 * `message` is already complete plain English; this lets the web app offer
 * the approved models.
 */
export const dataClassBlockedDetailsSchema = z.object({
  point: z.enum(CLASSIFICATION_BLOCK_POINTS),
  model: z.object({ slug: z.string(), displayName: z.string() }).optional(),
  missing: z.array(dataClassSchema.extend({ reasons: z.array(z.enum(CLASSIFICATION_REASONS)) })),
  approvedModels: z.array(z.object({ slug: z.string(), displayName: z.string() })),
});
export type DataClassBlockedDetails = z.infer<typeof dataClassBlockedDetailsSchema>;

/**
 * The reply part shown when a send went ahead in mode `warn` (`type:
 * 'data-classification'`): what `block` would have refused. Carries names
 * because the person already sees their own conversation's labels.
 */
export const dataClassificationPartSchema = z.object({
  mode: z.literal('warn'),
  point: z.enum(CLASSIFICATION_POINTS),
  model: z.string().optional(),
  missing: z.array(z.string()),
});
export type DataClassificationPartData = z.infer<typeof dataClassificationPartSchema>;

/** Audit actions this module writes (see docs/admin/audit-reporting.md). */
export const CLASSIFICATION_AUDIT_ACTIONS = [
  'data_class.create',
  'data_class.update',
  'data_class.retire',
  'data_class.delete',
  'model.data_classes.update',
  'connector.data_classes.update',
  'settings.classification.update',
  'project.data_classes.update',
  'thread.data_class.add',
  'thread.data_class.remove',
  'classification.block',
  'classification.warn',
] as const;

/**
 * `GET /admin/users/:id/projects`: one person's projects with their labels,
 * so an administrator can set (and lock) them. Names are shown to
 * administrators only, here.
 */
export const adminUserProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  classes: z.array(dataClassSchema.extend({ locked: z.boolean() })),
});
export type AdminUserProject = z.infer<typeof adminUserProjectSchema>;

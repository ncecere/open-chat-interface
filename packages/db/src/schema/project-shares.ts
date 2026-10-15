import { sql } from 'drizzle-orm';
import { check, index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { user } from './auth.js';
import { project } from './chat.js';
import { group } from './groups.js';

export type ProjectSharePermission = 'viewer' | 'editor';
export type ProjectShareSubjectType = 'person' | 'group';

/**
 * A project shared with a person or a group (v0.14, #394, migration 0054). A
 * viewer reads the project and uses it in their own conversations; an editor
 * also edits instructions and files; ownership stays `project.user_id` and moves
 * only by transfer. Access is computed per request from this table, `project`
 * and `group_member`, never cached or copied. Exactly one subject column is set,
 * matching `subject_type`. Every foreign key cascades (never RESTRICT): a
 * previous-release replica deleting a project or an account is never blocked by
 * rows it cannot see.
 */
export const projectShare = pgTable(
  'project_share',
  {
    id: primaryId(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').$type<ProjectShareSubjectType>().notNull(),
    subjectUserId: text('subject_user_id').references(() => user.id, { onDelete: 'cascade' }),
    subjectGroupId: text('subject_group_id').references(() => group.id, { onDelete: 'cascade' }),
    permission: text('permission').$type<ProjectSharePermission>().notNull(),
    createdByUserId: text('created_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('project_share_person_unique')
      .on(t.projectId, t.subjectUserId)
      .where(sql`${t.subjectUserId} is not null`),
    uniqueIndex('project_share_group_unique')
      .on(t.projectId, t.subjectGroupId)
      .where(sql`${t.subjectGroupId} is not null`),
    index('project_share_subject_user_idx')
      .on(t.subjectUserId)
      .where(sql`${t.subjectUserId} is not null`),
    index('project_share_subject_group_idx')
      .on(t.subjectGroupId)
      .where(sql`${t.subjectGroupId} is not null`),
    check('project_share_subject_type', sql`${t.subjectType} in ('person', 'group')`),
    check('project_share_permission', sql`${t.permission} in ('viewer', 'editor')`),
    check(
      'project_share_one_subject',
      sql`(${t.subjectType} = 'person' and ${t.subjectUserId} is not null and ${t.subjectGroupId} is null)
        or (${t.subjectType} = 'group' and ${t.subjectGroupId} is not null and ${t.subjectUserId} is null)`,
    ),
  ],
);

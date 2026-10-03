import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place the API deletes rows or stored objects, and how each treats a
 * legal hold (v0.10, "Legal hold covers everything").
 *
 * `hold` paths remove a person's data and check the hold; each one names the
 * row of `__tests__/live/legal-hold-paths.live.test.ts` that proves it against
 * PostgreSQL. `exempt` paths remove something that is not a person's records
 * (configuration, credentials, queues, work in progress) or only follow a
 * deletion that already checked; the reason says which.
 *
 * The scan below fails when a deletion appears that is not listed here, so a
 * new path cannot skip the question. Backups (`services/backups/`) are left
 * out: their retention deletes backup copies, not records (see
 * docs/admin/compliance.md).
 */
const PATHS: Record<string, { hold: 'checked' | 'exempt'; how: string }> = {
  // Conversations, messages, files and artifacts.
  'services/lifecycle/destroy.ts thread': {
    hold: 'checked',
    how: 'Every caller excludes held owners: delete forever and empty trash refuse; trash purge, temporary expiry and opening an expired temporary chat skip them (live rows "Delete forever", "Empty trash", "Trash purge: conversations", "Temporary chat expiry", "Opening an expired temporary chat").',
  },
  'services/lifecycle/destroy.ts attachment': {
    hold: 'checked',
    how: 'Trash purge of files trashed on their own skips held owners (live row "Trash purge: files").',
  },
  'services/projects.ts project': {
    hold: 'checked',
    how: 'Refused under hold: projects have no trash and their files go with them (live row "Deleting a project").',
  },
  'services/projects.ts attachment': {
    hold: 'checked',
    how: 'Refused under hold (live row "Deleting a project file").',
  },
  'services/memory/store.ts userMemory': {
    hold: 'checked',
    how: 'Deleting one or all memories, the forget tool and undo refuse; memory retention skips (live rows "Deleting a memory", "Deleting every memory", "The forget tool", "Memory retention").',
  },
  'services/admin-users/mutations.ts user': {
    hold: 'checked',
    how: 'Refused with a clear message, and by the database trigger on every path (live rows "Deleting the account", "refuses account deletion in the database").',
  },
  'services/admin-users/mutations.ts usageEvent': {
    hold: 'checked',
    how: 'Only in-flight reservations, in the account deletion transaction that the hold refuses (live rows "Deleting the account", "refuses account deletion in the database"); measured usage is kept without the person.',
  },
  'services/lifecycle/retention.ts usageEvent': {
    hold: 'checked',
    how: 'Usage-event pruning skips held people (live row "Usage-event pruning").',
  },
  'services/lifecycle/retention.ts shareLink': {
    hold: 'checked',
    how: 'Share-link pruning skips held owners (live row "Share-link pruning").',
  },
  'services/lifecycle/retention.ts auditLog': {
    hold: 'checked',
    how: 'Keeps entries by or about held people, including deletion events for their data (live row "Audit retention").',
  },
  'services/invitations.ts user': {
    hold: 'exempt',
    how: 'Rolls back the account created a moment earlier in the same failed redemption; nobody can have placed a hold on it, and the trigger would refuse anyway.',
  },
  'services/attachments/upload.ts attachment': {
    hold: 'exempt',
    how: 'Removes the row of an upload that failed before it completed (upload_pending); it never held a file.',
  },
  'services/chat/run-cleanup.ts message': {
    hold: 'exempt',
    how: 'Removes the empty, parentless reply placeholder of a turn that was never committed.',
  },
  'services/quota/settlement.ts usageEvent': {
    hold: 'exempt',
    how: 'Releases a reservation for a reply that never started: no usage happened.',
  },
  'services/lifecycle/trash-thread.ts conversationCompactionJob': {
    hold: 'exempt',
    how: 'Drops a queued summary job when its conversation moves to the trash; the conversation is kept.',
  },
  'services/chat/compaction-queue.ts conversationCompactionFailure': {
    hold: 'exempt',
    how: 'The notice that a requested summary failed, removed when dismissed, asked again or succeeded; no record of the conversation.',
  },
  'services/chat/compaction-queue.ts job': {
    hold: 'exempt',
    how: 'Finished summary jobs leave the queue; summaries add to a conversation and never delete messages.',
  },
  'services/portability/imports.ts conversationImport': {
    hold: 'exempt',
    how: 'An import upload is a copy of data from elsewhere; what it imports becomes conversations, which are held.',
  },
  'services/portability/imports.ts object': {
    hold: 'exempt',
    how: 'The stored import upload, released after processing or with its import (above).',
  },
  'services/storage/reaper.ts object': {
    hold: 'exempt',
    how: 'Deletes objects queued by the attachment delete trigger, only after a deletion path above removed the row.',
  },
  'services/storage/reaper.ts deletedObject': {
    hold: 'exempt',
    how: 'Prunes drained queue rows of objects already deleted.',
  },
  'services/storage/index.ts object': {
    hold: 'exempt',
    how: 'Removes an object whose upload failed before its row was written.',
  },
  'services/compliance/export.ts object': {
    hold: 'exempt',
    how: 'The export cleans up its own objects (failed runs, and pruning older exports when configured).',
  },
  'services/project-search/embedding.ts projectFileEmbeddingFailure': {
    hold: 'exempt',
    how: 'A retry bookkeeping row for search indexing.',
  },
  // Sessions, verification tokens and invitations: credentials, not records.
  'auth/provisioning.ts session': { hold: 'exempt', how: 'Sessions are credentials.' },
  'services/account-sessions.ts session': { hold: 'exempt', how: 'Sessions are credentials.' },
  'services/admin-users/bulk-actions.ts session': {
    hold: 'exempt',
    how: 'Sessions are credentials.',
  },
  'services/admin-users/mutations.ts session': { hold: 'exempt', how: 'Sessions are credentials.' },
  'services/lifecycle/retention.ts session': { hold: 'exempt', how: 'Sessions are credentials.' },
  'services/lifecycle/retention.ts verification': {
    hold: 'exempt',
    how: 'Expired verification tokens are credentials.',
  },
  'services/lifecycle/retention.ts invitation': {
    hold: 'exempt',
    how: 'Spent or expired invitations; not a person’s records.',
  },
  'routes/admin/invites.ts invitation': { hold: 'exempt', how: 'Revoking an invitation.' },
  'services/connectors/admin.ts connectorAccount': {
    hold: 'exempt',
    how: 'Connector credentials, not records.',
  },
  'services/connectors/oauth.ts connectorAccount': {
    hold: 'exempt',
    how: 'Connector credentials, not records.',
  },
  // Instance configuration and operational queues.
  'routes/admin/broadcasts.ts broadcast': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/broadcasts.ts broadcastDismissal': {
    hold: 'exempt',
    how: 'Re-showing a broadcast clears who dismissed it.',
  },
  'routes/admin/lifecycle.ts storagePolicy': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/models.ts model': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/providers.ts provider': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/reports.ts scheduledReport': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/sso.ts ssoProvider': { hold: 'exempt', how: 'Instance configuration.' },
  'routes/admin/views.ts savedView': { hold: 'exempt', how: 'An administrator’s saved filter.' },
  'services/connectors/admin.ts connector': { hold: 'exempt', how: 'Instance configuration.' },
  'services/quota/override-admin.ts quotaPolicyOverride': {
    hold: 'exempt',
    how: 'Instance configuration.',
  },
  'services/lifecycle/retention.ts quotaPolicyOverride': {
    hold: 'exempt',
    how: 'Lapsed configuration.',
  },
  'services/quota/policy-admin.ts quotaPolicy': { hold: 'exempt', how: 'Instance configuration.' },
  'services/quota/policy-assignments.ts quotaPolicyModel': {
    hold: 'exempt',
    how: 'Instance configuration.',
  },
  'services/quota/policy-assignments.ts quotaPolicyRole': {
    hold: 'exempt',
    how: 'Instance configuration.',
  },
  'services/webhooks/delivery.ts webhookDelivery': {
    hold: 'exempt',
    how: 'Delivered webhook queue rows; the audit entries they carried stay.',
  },
  'services/webhooks/endpoints.ts webhookEndpoint': {
    hold: 'exempt',
    how: 'Instance configuration.',
  },
};

const SRC = join(import.meta.dirname, '../..');
const DELETION =
  /\b(db|tx|driver|executor)\s*\.delete\(\s*([\w.]+)|delete\s+from\s+(?:\$\{schema\.(\w+)\}|"?(\w+)"?)/gi;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function deletionsInCode(): Set<string> {
  const found = new Set<string>();
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split('\\').join('/');
    if (file.startsWith('services/backups/')) continue;
    for (const match of readFileSync(path, 'utf8').matchAll(DELETION)) {
      const table = match[1]
        ? match[1] === 'driver'
          ? 'object'
          : match[2]!.replace(/^schema\./, '')
        : (match[3] ?? match[4]);
      found.add(`${file} ${table}`);
    }
  }
  return found;
}

describe('legal hold: every deletion path is classified', () => {
  const found = deletionsInCode();

  it('lists every deletion in the code', () => {
    const unlisted = [...found].filter((key) => !(key in PATHS)).sort();
    expect(unlisted, 'Classify these in PATHS: do they need to check the legal hold?').toEqual([]);
  });

  it('lists nothing that is no longer in the code', () => {
    expect(Object.keys(PATHS).filter((key) => !found.has(key))).toEqual([]);
  });

  it('names the live test or the reason for every path', () => {
    for (const [key, entry] of Object.entries(PATHS)) {
      expect(entry.how.length, key).toBeGreaterThan(10);
      if (entry.hold === 'checked') expect(entry.how, key).toMatch(/live row|refuse|skip/i);
    }
  });
});

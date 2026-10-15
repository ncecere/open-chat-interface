import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every file that reads or writes project data, and how it answers "who may
 * see this?" (v0.14, project sharing, #394). A shared project means a file that
 * once could assume "the person asking is the owner" now cannot, so a new query
 * must not skip the question: this scan fails when a file touching
 * `schema.project`, an attachment's `projectId`/`project_id`, a project's file
 * chunks, embeddings, search index or shares is not listed here.
 *
 * - **A** access-aware: decides with `projectAccess` / `requireProjectAccess` /
 *   `projectReadableBy` (project-sharing/access.ts) for the person asking.
 * - **O** owner-only on purpose: the owner's operation (rename, delete, share,
 *   transfer), or a person's own message files. Another person's access never
 *   widens it.
 * - **S** system job or helper with no actor: keyed by an id that an A path
 *   already scoped, or a maintenance sweep.
 * - **U** unchanged and correct: never answers a question about a person's
 *   access (counts, ids only, instance-wide, the uploader's own files).
 *
 * The reason says why, and the live matrix names the cells that prove an A.
 * (The pattern of legal-hold-paths.unit.test.ts.)
 */
type Class = 'A' | 'O' | 'S' | 'U';
/** `via` names what an A file calls to decide; the test checks the file mentions it. */
type Entry = { class: Class; why: string; via?: string };

const FILES: Record<string, Entry> = {
  // Routes.
  'routes/projects.ts': {
    class: 'A',
    via: 'requireProjectAccess',
    why: 'Every route resolves the caller’s access first (404 for none, 403 for too little); sharing routes are owner-only through it. Matrix rows: every action.',
  },
  'routes/threads.ts': {
    class: 'A',
    via: 'requireProjectAccess',
    why: 'Listing a project’s conversations and moving into a project need read access; the conversations listed stay the caller’s own (thread.user_id).',
  },
  'routes/attachments.ts': {
    class: 'A',
    via: 'getReadableAttachment',
    why: 'GET /:id/content serves an own file or a live project file the caller can read; the other routes list and delete own files.',
  },
  'routes/index.ts': { class: 'U', why: 'Only mounts the project routes; no query.' },
  'routes/admin/embeddings.ts': {
    class: 'U',
    why: 'The administrator’s embeddings page: instance-wide counts and settings, no project content.',
  },
  'routes/admin/health.ts': {
    class: 'U',
    why: 'Instance-wide counts of unsent uploads (excludes project files); administrators see no project content.',
  },
  // Projects, shares, threads.
  'services/projects.ts': {
    class: 'A',
    via: 'projectAccess',
    why: 'Lists, summaries, edits, files and moves decide by access; rename, delete, share and transfer stay owner-only (getOwnedProject).',
  },
  'services/threads.ts': {
    class: 'A',
    via: 'projectAccess',
    why: 'A conversation may start in any project the person can read; forks and edits copy projectId only while access holds. Listing stays thread.user_id-scoped.',
  },
  'services/thread-summary.ts': {
    class: 'U',
    why: 'Serialises a thread row for its own owner; the project id is just a column.',
  },
  'services/thread-search.ts': {
    class: 'U',
    why: 'Only imports the text-array helper; thread search is thread.user_id-scoped.',
  },
  // Files.
  'services/attachments/index.ts': {
    class: 'A',
    via: 'projectReadableBy',
    why: 'getReadableAttachment: an own file, or a live project file the person can read. The Settings list shows own uploads and the project name only while the project is readable.',
  },
  'services/attachments/upload.ts': {
    class: 'A',
    via: 'projectAccess',
    why: 'A project upload checks owner or editor under the project row lock; quota, limits and the cap are the uploader’s.',
  },
  'services/attachments/copies.ts': {
    class: 'U',
    why: 'Forks and edits copy message files only (isNull(projectId)); a project file is never copied.',
  },
  'services/attachments/extract.ts': {
    class: 'U',
    why: 'Mentions the index table in a comment only.',
  },
  'services/storage/usage.ts': {
    class: 'U',
    why: 'Counts files by uploader (user_id): files count against the uploader, which sharing keeps.',
  },
  'services/storage/quota.ts': {
    class: 'U',
    why: 'The storage meter splits an uploader’s own bytes into chat and project files.',
  },
  // Chat context.
  'services/chat/project-context.ts': {
    class: 'A',
    via: 'projectAccess',
    why: 'Resolves access first; none means an ordinary conversation. Passages, headings and file names read through the actor’s access.',
  },
  'services/chat/attachment-context.ts': {
    class: 'A',
    via: 'projectReadableBy',
    why: 'inspectProjectFiles and the project half of materializeAttachments read every file of a project the actor can read; message files stay user_id-scoped.',
  },
  'services/chat/model-context.ts': {
    class: 'A',
    via: 'materializeAttachments',
    why: 'Passes the project candidates to materializeAttachments as project files, apart from the person’s own message files.',
  },
  'services/chat/turn-context.ts': {
    class: 'U',
    why: 'Calls assertExcludableProjectFiles (project-context.ts, A); no query of its own.',
  },
  'services/chat/prepare-turn.ts': { class: 'U', why: 'Imports a type; carries the stored note.' },
  // Search and vectors.
  'services/project-search/retrieval.ts': {
    class: 'A',
    via: 'projectReadableBy',
    why: 'scopedChunks admits a file only while the asker can read its project; indexedChunkCounts takes ids that scope already filtered (U, proved by a test).',
  },
  'services/project-search/semantic.ts': {
    class: 'A',
    via: 'scopedChunks',
    why: 'Vector hits pass the store’s scope filter and are re-read through scopedChunks for the asker; the question’s embedding is charged to the asker.',
  },
  'services/project-search/excerpts.ts': {
    class: 'A',
    via: 'projectReadableBy',
    why: 'Headings are read from file text only for a project the asker can read.',
  },
  'services/project-search/rerank.ts': {
    class: 'U',
    why: 'Reorders passages already scoped by A paths; usage goes to the asker.',
  },
  'services/project-search/indexing.ts': {
    class: 'S',
    why: 'Chunks a file by attachment id (upload and the projects.index-files job); no actor.',
  },
  'services/project-search/embedding.ts': {
    class: 'S',
    why: 'Embeds passages by attachment id in a job; passages are charged to the uploader.',
  },
  'services/embeddings/generations.ts': {
    class: 'S',
    why: 'Embedding generation bookkeeping and fills, keyed by attachment; no actor.',
  },
  'services/embeddings/rebuild.ts': {
    class: 'S',
    why: 'Jobs that fill and switch embedding generations.',
  },
  'services/embeddings/status.ts': {
    class: 'U',
    why: 'Instance-wide embedding counts for administrators; no content.',
  },
  'services/vector-store/pgvector-sql.ts': {
    class: 'A',
    via: 'projectReadableBy',
    why: 'scopeFilter admits vectors only of live files of a project the actor can read; it still throws VectorScopeError without an actor and a project.',
  },
  'services/vector-store/pgvector.ts': {
    class: 'A',
    via: 'scopeFilter',
    why: 'Searches and presence checks apply scopeFilter; deleteByProject and deleteByPerson are keyed by attachment (S).',
  },
  'services/project-search/chunking.ts': {
    class: 'U',
    why: 'Splits text into passages: a pure function with no query.',
  },
  'services/project-search/fusion.ts': {
    class: 'U',
    why: 'Merges two ranked lists of already-scoped passages: a pure function.',
  },
  'services/project-search/passages.ts': {
    class: 'U',
    why: 'Picks and renders passages already scoped by the A paths: a pure function.',
  },
  'services/project-search/relevance.ts': {
    class: 'U',
    why: 'Relevance floors over scores: a pure function with no query.',
  },
  'services/vector-store/index.ts': {
    class: 'U',
    why: 'Returns the one store implementation; no query.',
  },
  'services/vector-store/types.ts': {
    class: 'U',
    why: 'Types only: the vector scope shape and the store interface.',
  },
  // Lifecycle, portability, accounts, compliance, jobs.
  'services/lifecycle/destroy.ts': {
    class: 'U',
    why: 'Deletes threads and files by owner or age; a viewer’s conversations die as before and never touch the project; project files have no trash.',
  },
  'services/portability/export-archive.ts': {
    class: 'A',
    via: 'projectAttachments',
    why: 'The owner’s export has every file of their projects; a member’s export adds shared-projects/ with only the files they added.',
  },
  'services/portability/export-attachments.ts': {
    class: 'U',
    why: 'Message files only (isNull(projectId)).',
  },
  'services/admin-users/mutations.ts': {
    class: 'A',
    via: 'handOverFilesOf',
    why: 'Deleting an editor first moves the files they added to the owners; deleting an owner cascades and records sharedProjects.',
  },
  'services/compliance/deletions.ts': {
    class: 'U',
    why: 'Names ids and action types of deletions; no project content.',
  },
  'services/compliance/export-lines.ts': {
    class: 'U',
    why: 'Exports a thread’s project id only; no project content is exported today.',
  },
  'services/jobs/index.ts': {
    class: 'S',
    why: 'Registers the project jobs (index, embed, reconcile-access).',
  },
};

const SRC = join(import.meta.dirname, '../..');

/**
 * What makes a file "touch project data". Deliberately broad: a raw `from
 * project` and a Drizzle `schema.project` both count, as do the tables that hang
 * off a project's files.
 */
const TOUCHES = [
  /\bschema\.project\b/,
  /\bschema\.projectShare\b/,
  /\bschema\.projectFile\w*/,
  /\bschema\.attachment\b[\s\S]{0,400}?\bprojectId\b|\bprojectId\b[\s\S]{0,400}?\bschema\.attachment\b/,
  /\bproject_file_(chunk|embedding\w*|index)\b/,
  /\bproject_share\b/,
  /\b(?:from|join|update|into)\s+"?project"?(?=[\s;)"]|$)/i,
  /"project"\."/,
  /\ba\.project_id\b|\battachment\.project_id\b|"project_id"/,
  /\bprojectId\b|\bproject_id\b|\bprojectFileTotals\b/,
  /from '[./]+(?:[\w-]+\/)*(?:projects|project-context|project-search\/[\w-]+|vector-store\/[\w-]*|project-sharing\/[\w-]+)\.js'/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function filesInCode(): string[] {
  return sources(SRC)
    .filter((path) => {
      const file = relative(SRC, path).split('\\').join('/');
      // The search and vector code is project data by where it lives.
      if (/^services\/(project-search|project-sharing|vector-store)\//.test(file)) return true;
      const text = readFileSync(path, 'utf8');
      return TOUCHES.some((pattern) => pattern.test(text));
    })
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .sort();
}

describe('project data: every file that touches it is classified', () => {
  const found = filesInCode();

  it('lists every file in the code', () => {
    const unlisted = found.filter((file) => !(file in FILES));
    expect(
      unlisted.join('\n'),
      'Classify these in FILES: A (access-aware), O (owner-only on purpose), S (system) or U (unchanged), with a reason. Does the file answer who may see a project?',
    ).toBe('');
  });

  it('lists nothing that no longer touches project data', () => {
    expect(
      Object.keys(FILES)
        .filter((file) => !found.includes(file))
        .join('\n'),
    ).toBe('');
  });

  it('gives a class and a reason for every file', () => {
    for (const [file, entry] of Object.entries(FILES)) {
      expect(['A', 'O', 'S', 'U'], file).toContain(entry.class);
      expect(entry.why.length, file).toBeGreaterThan(20);
    }
  });

  it('proves every A file names what it decides with', () => {
    // An "A" that never mentions its access function is a mislabel, which is how
    // a query would slip through: check the claim rather than trust it.
    const mislabelled = Object.entries(FILES)
      .filter(([, entry]) => entry.class === 'A')
      .filter(
        ([file, entry]) => !entry.via || !readFileSync(join(SRC, file), 'utf8').includes(entry.via),
      )
      .map(([file]) => file);
    expect(
      mislabelled.join('\n'),
      'These are listed A but never use the access function they name',
    ).toBe('');
  });
});

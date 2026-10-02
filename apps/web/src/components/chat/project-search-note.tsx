import { type ProjectSearchData, projectSearchDataSchema } from '@oci/shared';
import type { UIMessage } from 'ai';
import { FileSearch } from 'lucide-react';

/**
 * Reads the `data-project-search` part a reply carries when its project's
 * files were too large to give the model whole and passages were used
 * instead. The part names files and counts passages; it never holds their text.
 */
export function projectSearchOf(message: UIMessage): ProjectSearchData | null {
  const part = message.parts.find((candidate) => candidate.type === 'data-project-search') as
    | { data?: unknown }
    | undefined;
  if (!part) return null;
  const parsed = projectSearchDataSchema.safeParse(part.data);
  return parsed.success && parsed.data.files.length > 0 ? parsed.data : null;
}

function describeFiles(files: ProjectSearchData['files']): string {
  return files
    .map(
      (file) => `${file.name} (${file.passages} ${file.passages === 1 ? 'passage' : 'passages'})`,
    )
    .join(', ');
}

/** A short note on a reply that used searched passages of the project's files. */
export function ProjectSearchNote({ message }: { message: UIMessage }) {
  const search = projectSearchOf(message);
  if (!search) return null;
  const searched =
    search.ranking === 'hybrid'
      ? 'Searched project files by meaning and keywords'
      : 'Searched project files';
  const lead =
    search.mode === 'opening'
      ? 'Project files were too long to use in full and nothing matched. Used the opening passages of'
      : `${searched}${search.reranked ? ' and reranked the results' : ''}. Used passages from`;
  return (
    <p
      role="note"
      className="mb-2 flex items-start gap-1.5 text-xs text-[var(--text-muted)]"
      data-project-search={search.mode}
      data-project-ranking={search.ranking ?? 'keyword'}
      data-project-reranked={search.reranked === undefined ? undefined : String(search.reranked)}
    >
      <FileSearch className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {lead} {describeFiles(search.files)}.
      </span>
    </p>
  );
}

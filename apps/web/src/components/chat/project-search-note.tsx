import { type ProjectSearchData, projectSearchDataSchema } from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, ChevronRight, FileSearch } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * Reads the `data-project-search` part a reply carries when its project's
 * files were too large to give the model whole and passages were used
 * instead, or when the person left files out of the message (v0.10). The part
 * names files and counts passages; since v0.10 it also holds the start of
 * each passage used, which older replies do not have.
 */
export function projectSearchOf(message: UIMessage): ProjectSearchData | null {
  const part = message.parts.find((candidate) => candidate.type === 'data-project-search') as
    | { data?: unknown }
    | undefined;
  if (!part) return null;
  const parsed = projectSearchDataSchema.safeParse(part.data);
  return parsed.success && (parsed.data.files.length > 0 || parsed.data.excluded?.length)
    ? parsed.data
    : null;
}

function describeFiles(files: ProjectSearchData['files']): string {
  return files
    .map(
      (file) => `${file.name} (${file.passages} ${file.passages === 1 ? 'passage' : 'passages'})`,
    )
    .join(', ');
}

function passageLabel(excerpt: { first: number; last: number }): string {
  return excerpt.first === excerpt.last
    ? `Passage ${excerpt.first}`
    : `Passages ${excerpt.first}–${excerpt.last}`;
}

function leadOf(search: ProjectSearchData): string | null {
  if (search.files.length === 0) return null;
  const searched =
    search.ranking === 'hybrid'
      ? 'Searched project files by meaning and keywords'
      : 'Searched project files';
  const lead =
    search.mode === 'opening'
      ? 'Project files were too long to use in full and nothing matched. Used the opening passages of'
      : `${searched}${search.reranked ? ' and reranked the results' : ''}. Used passages from`;
  return `${lead} ${describeFiles(search.files)}.`;
}

/** The passages a reply used, by file: the start of each and its section when known. */
function PassageList({ id, files }: { id: string; files: ProjectSearchData['files'] }) {
  return (
    <ul id={id} className="mt-1.5 flex flex-col gap-2 pl-5" data-testid="project-search-passages">
      {files.map((file) =>
        file.excerpts?.length ? (
          <li key={file.name} className="min-w-0">
            <p className="break-words font-medium text-[var(--text-secondary)]">{file.name}</p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {file.excerpts.map((excerpt) => (
                <li
                  key={excerpt.id}
                  className="min-w-0 border-l-2 border-[var(--border-subtle)] pl-2"
                >
                  <p className="text-[var(--text-muted)]">
                    {passageLabel(excerpt)}
                    {excerpt.heading ? ` · ${excerpt.heading}` : ''}
                  </p>
                  <p className="break-words text-[var(--text-secondary)]">{excerpt.snippet}</p>
                </li>
              ))}
            </ul>
          </li>
        ) : null,
      )}
    </ul>
  );
}

/**
 * A short note on a reply that used searched passages of the project's files,
 * or for which the person left files out. Since v0.10 it expands to list the
 * passages used; replies stored earlier have no passages to list.
 */
export function ProjectSearchNote({ message }: { message: UIMessage }) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const search = projectSearchOf(message);
  if (!search) return null;
  const lead = leadOf(search);
  const excluded = search.excluded ?? [];
  const leftOut =
    excluded.length > 0
      ? `Left out of this message: ${excluded.map((file) => file.name).join(', ')}.`
      : null;
  const listed = search.files.some((file) => file.excerpts?.length);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="mb-2 text-xs text-[var(--text-muted)]">
      <p
        role="note"
        className="flex items-start gap-1.5"
        data-project-search={search.mode}
        data-project-ranking={search.ranking ?? 'keyword'}
        data-project-reranked={search.reranked === undefined ? undefined : String(search.reranked)}
      >
        <FileSearch className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{[lead, leftOut].filter(Boolean).join(' ')}</span>
      </p>
      {listed && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => setOpen((value) => !value)}
            className="mt-1 ml-5 inline-flex items-center gap-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-faint)]"
          >
            <Chevron className="size-3" aria-hidden="true" />
            {open ? 'Hide passages used' : 'Show passages used'}
          </button>
          {open && <PassageList id={listId} files={search.files} />}
        </>
      )}
    </div>
  );
}

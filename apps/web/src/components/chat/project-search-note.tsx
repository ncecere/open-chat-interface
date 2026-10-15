import { type ProjectSearchData, projectSearchDataSchema } from '@oci/shared';
import type { UIMessage } from 'ai';
import { ChevronDown, ChevronRight, FileSearch } from 'lucide-react';
import { useId, useState } from 'react';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { translate, useT } from '~/lib/i18n';

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
  return parsed.success &&
    (parsed.data.files.length > 0 || parsed.data.excluded?.length || parsed.data.withheld?.length)
    ? parsed.data
    : null;
}

function describeFiles(files: ProjectSearchData['files']): string {
  return files
    .map((file) =>
      translate('chat.projectSearch.fileEntry', { name: file.name, count: file.passages }),
    )
    .join(translate('chat.projectSearch.separator'));
}

/**
 * Which outside services data classification kept out of this reply (v0.14,
 * #395): meaning-based search sends the message to an embeddings provider, and
 * reranking sends it with the passages to a reranker.
 */
function withheldText(withheld: ProjectSearchData['withheld']): string | null {
  if (!withheld?.length) return null;
  const meaning = withheld.includes('embeddings');
  const reranking = withheld.includes('reranking');
  if (meaning && reranking) return translate('chat.projectSearch.withheldBoth');
  return translate(
    meaning ? 'chat.projectSearch.withheldMeaning' : 'chat.projectSearch.withheldRerank',
  );
}

function passageLabel(excerpt: { first: number; last: number }): string {
  return excerpt.first === excerpt.last
    ? translate('chat.projectSearch.passage', { n: excerpt.first })
    : translate('chat.projectSearch.passages', { first: excerpt.first, last: excerpt.last });
}

function leadOf(search: ProjectSearchData): string | null {
  if (search.files.length === 0) return null;
  const files = describeFiles(search.files);
  if (search.mode === 'opening') return translate('chat.projectSearch.leadOpening', { files });
  const hybrid = search.ranking === 'hybrid';
  const key = hybrid
    ? search.reranked
      ? 'chat.projectSearch.leadHybridReranked'
      : 'chat.projectSearch.leadHybrid'
    : search.reranked
      ? 'chat.projectSearch.leadReranked'
      : 'chat.projectSearch.lead';
  return translate(key, { files });
}

/** The passages a reply used, by file: the start of each and its section when known. */
function PassageList({ id, files }: { id: string; files: ProjectSearchData['files'] }) {
  return (
    <ul id={id} className="mt-1.5 flex flex-col gap-2 ps-5" data-testid="project-search-passages">
      {files.map((file) =>
        file.excerpts?.length ? (
          <li key={file.name} className="min-w-0">
            <p dir="auto" className="break-words font-medium text-[var(--text-secondary)]">
              {file.name}
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {file.excerpts.map((excerpt) => (
                <li
                  key={excerpt.id}
                  className="min-w-0 border-s-2 border-[var(--border-subtle)] ps-2"
                >
                  <p className="text-[var(--text-muted)]">
                    {excerpt.heading
                      ? translate('chat.projectSearch.passageHeading', {
                          label: passageLabel(excerpt),
                          heading: excerpt.heading,
                        })
                      : passageLabel(excerpt)}
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
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const search = projectSearchOf(message);
  if (!search) return null;
  const lead = leadOf(search);
  const withheld = withheldText(search.withheld);
  const excluded = search.excluded ?? [];
  const leftOut =
    excluded.length > 0
      ? t('chat.projectSearch.leftOut', {
          files: excluded.map((file) => file.name).join(t('chat.projectSearch.separator')),
        })
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
        data-project-withheld={search.withheld?.join(' ')}
      >
        <FileSearch className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {[lead, withheld, leftOut].filter(Boolean).join(' ')}
        </span>
      </p>
      {listed && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            onClick={() => setOpen((value) => !value)}
            className={`mt-1 ms-5 inline-flex items-center gap-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] ${FOCUS_RING}`}
          >
            <Chevron className="size-3" aria-hidden="true" />
            {open ? t('chat.projectSearch.hide') : t('chat.projectSearch.show')}
          </button>
          {open && <PassageList id={listId} files={search.files} />}
        </>
      )}
    </div>
  );
}

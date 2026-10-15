import type { ClassificationResponse } from '@oci/shared';
import { DataClassLabels } from '~/components/classification/data-class-labels';
import {
  useAddThreadLabel,
  useDataClasses,
  useRemoveThreadLabel,
} from '~/hooks/use-classification';
import { isClassifying } from '~/lib/classification';

/**
 * The data classes this conversation carries, as chips under its title, and
 * "Add label" (#395). Shown only while classification is on and there is
 * something to say or add; with the feature off nothing appears (and nothing
 * is fetched), so a conversation looks exactly as it did before.
 *
 * `classification` is the page's own `GET /api/classification` answer, so the
 * chips, the model picker and the composer's note always agree.
 */
export function ConversationLabels({
  threadId,
  classification,
}: {
  threadId: string;
  classification: ClassificationResponse | undefined;
}) {
  if (!isClassifying(classification)) return null;
  return <Labels threadId={threadId} carried={classification.classes} />;
}

function Labels({
  threadId,
  carried,
}: {
  threadId: string;
  carried: ClassificationResponse['classes'];
}) {
  const available = useDataClasses();
  const add = useAddThreadLabel(threadId);
  const remove = useRemoveThreadLabel(threadId);
  const addable = (available.data ?? []).filter(
    (entry) => !carried.some((carriedClass) => carriedClass.id === entry.id),
  );
  // Nothing to show and nothing a person could add.
  if (carried.length === 0 && addable.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[47rem] shrink-0 px-6 pt-3 md:px-3">
      <DataClassLabels
        scope="thread"
        classes={carried}
        addable={addable}
        onAdd={(classId) => add.mutate(classId)}
        onRemove={(classId) => remove.mutate(classId)}
        pending={add.isPending || remove.isPending}
        error={add.error ?? remove.error}
      />
    </div>
  );
}

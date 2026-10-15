import { DataClassLabels } from '~/components/classification/data-class-labels';
import { useClassification, useDataClasses, useSetProjectLabels } from '~/hooks/use-classification';
import { isClassifying } from '~/lib/classification';
import { useT } from '~/lib/i18n';
import { Section } from './project-sections';

/**
 * The project's data classes, set by its owner (v0.14, #395): every
 * conversation in the project carries them, and so only models approved for
 * them take its messages. A label an administrator set is locked and stays
 * until an administrator removes it. Not shown while classification is off.
 */
export function ProjectLabelsSection({ projectId }: { projectId: string }) {
  const t = useT();
  const classification = useClassification({ projectId });
  const on = isClassifying(classification.data);
  const available = useDataClasses(on);
  const save = useSetProjectLabels(projectId);
  if (!isClassifying(classification.data)) return null;

  const carried = classification.data.classes;
  const addable = (available.data ?? []).filter(
    (entry) => !carried.some((carriedClass) => carriedClass.id === entry.id),
  );
  if (carried.length === 0 && addable.length === 0) return null;
  const ids = carried.map((entry) => entry.id);

  return (
    <Section title={t('classify.project.title')} description={t('classify.project.description')}>
      <DataClassLabels
        scope="project"
        classes={carried}
        addable={addable}
        onAdd={(classId) => save.mutate([...ids, classId])}
        onRemove={(classId) => save.mutate(ids.filter((id) => id !== classId))}
        pending={save.isPending}
        error={save.error}
      />
    </Section>
  );
}

import type { ClassificationClass } from '@oci/shared';
import { formatList, translate } from '~/lib/i18n';
import { isolate } from '~/lib/projects-text';

/**
 * Why a conversation or project carries a class, in the words the chips use:
 * "from the project", "from the SIS connector", "added by you". A class can
 * have several reasons. Connector names are the administrator's, shown as
 * they were written.
 */
export function reasonTexts(entry: ClassificationClass, scope: 'thread' | 'project'): string[] {
  const texts: string[] = [];
  for (const reason of entry.reasons) {
    if (reason === 'project') {
      texts.push(
        translate(
          scope === 'project'
            ? entry.locked
              ? 'classify.reason.projectLocked'
              : 'classify.reason.projectOwn'
            : entry.locked
              ? 'classify.reason.threadProjectLocked'
              : 'classify.reason.threadProject',
        ),
      );
    } else if (reason === 'connector') {
      const names = entry.connectorNames ?? [];
      texts.push(
        names.length === 0
          ? translate('classify.reason.connectorUnnamed')
          : translate('classify.reason.connector', {
              count: names.length,
              names: formatList(names.map(isolate)),
            }),
      );
    } else if (reason === 'person') {
      texts.push(translate('classify.reason.person'));
    } else {
      texts.push(keptText(entry.origins ?? []));
    }
  }
  return texts;
}

/** A `kept` label stays after what gave it was moved away from or deleted. */
function keptText(origins: readonly string[]): string {
  const connectors = origins.flatMap((origin) =>
    origin.startsWith('connector: ') ? [origin.slice('connector: '.length)] : [],
  );
  const fromProject = origins.includes('project');
  const parts = [
    ...(fromProject ? [translate('classify.reason.keptProject')] : []),
    ...connectors.map((name) =>
      translate('classify.reason.keptConnector', { name: isolate(name) }),
    ),
  ];
  return parts.length
    ? translate('classify.reason.kept', { parts: formatList(parts) })
    : translate('classify.reason.keptBefore');
}

/**
 * Why this label has no remove button, in one sentence for the person.
 * Only what the person added can be removed from the conversation.
 */
export function whyNotRemovable(entry: ClassificationClass, scope: 'thread' | 'project'): string {
  const name = isolate(entry.name);
  if (scope === 'project') return translate('classify.whyNot.admin', { name });
  const reasons = entry.reasons.filter((reason) => reason !== 'person');
  if (reasons.includes('connector')) return translate('classify.whyNot.connector', { name });
  if (reasons.includes('project')) return translate('classify.whyNot.project', { name });
  return translate('classify.whyNot.kept', { name });
}

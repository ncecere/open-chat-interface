import { translate } from '~/lib/i18n';

/**
 * What deleting a project does to what it holds, in words that fit the
 * counts: "Its 0 conversations are kept and leave the project." was said of
 * a project with none (#210). Each count has its own sentence, so a language
 * with other plural forms words it its own way.
 */
export function deleteProjectText(threadCount: number, fileCount: number): string {
  if (threadCount === 0 && fileCount === 0) return translate('projects.delete.contentsNone');
  const conversations = translate('projects.delete.contentsConversations', { count: threadCount });
  const files = translate('projects.delete.contentsFiles', { count: fileCount });
  return `${conversations} ${files}`;
}

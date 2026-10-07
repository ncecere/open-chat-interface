/**
 * What deleting a project does to what it holds, in words that fit the
 * counts: "Its 0 conversations are kept and leave the project." was said of
 * a project with none (#210).
 */
export function deleteProjectText(threadCount: number, fileCount: number): string {
  if (threadCount === 0 && fileCount === 0) return 'It has no conversations or files.';
  const conversations =
    threadCount === 0
      ? 'It has no conversations.'
      : threadCount === 1
        ? 'Its conversation is kept and leaves the project.'
        : `Its ${threadCount} conversations are kept and leave the project.`;
  const files =
    fileCount === 0
      ? 'It has no files.'
      : fileCount === 1
        ? 'Its file is deleted permanently.'
        : `Its ${fileCount} files are deleted permanently.`;
  return `${conversations} ${files}`;
}

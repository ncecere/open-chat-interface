import { expect, it } from 'vitest';
import { deleteProjectText } from '../../src/components/projects/delete-project-text';

it('words what deleting a project does to fit its counts (#210)', () => {
  expect(deleteProjectText(0, 1)).toBe('It has no conversations. Its file is deleted permanently.');
  expect(deleteProjectText(0, 0)).toBe('It has no conversations or files.');
  expect(deleteProjectText(1, 0)).toBe(
    'Its conversation is kept and leaves the project. It has no files.',
  );
  expect(deleteProjectText(3, 2)).toBe(
    'Its 3 conversations are kept and leave the project. Its 2 files are deleted permanently.',
  );
});

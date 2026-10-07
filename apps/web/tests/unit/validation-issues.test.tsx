// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MutationError } from '../../src/components/admin/admin-ui';
import { ApiError } from '../../src/lib/api-client';
import { describeValidationIssues } from '../../src/lib/validation-issues';

// What the API sent for the QA walk's examples (Zod 4 issues).
const issues = [
  { code: 'too_big', path: ['label'], origin: 'string', maximum: 80, message: 'Too big' },
  { code: 'too_small', path: ['keepCount'], origin: 'number', minimum: 1, message: 'Too small' },
  { code: 'too_big', path: ['windowHours'], origin: 'number', maximum: 8760, message: 'Too big' },
  {
    code: 'invalid_format',
    path: ['recipients', 1],
    origin: 'string',
    format: 'email',
    message: 'x',
  },
  { code: 'invalid_format', path: ['actions', 0], origin: 'string', format: 'regex', message: 'x' },
  { code: 'too_small', path: ['body'], origin: 'string', minimum: 1, message: 'Too small' },
];

it('names the field and the rule for each issue', () => {
  expect(describeValidationIssues(issues)).toEqual([
    'Label must be at most 80 characters.',
    'Keep count must be at least 1.',
    'Window hours must be at most 8,760.',
    'Recipients (item 2) must be a valid email address.',
    'Actions (item 1) contains characters that are not allowed.',
    'Body is required.',
  ]);
});

it("keeps the API's own sentences, prefixed with the field", () => {
  expect(
    describeValidationIssues([
      { path: ['apiKey'], message: 'An API key is required for this provider.' },
    ]),
  ).toEqual(['API key: An API key is required for this provider.']);
  expect(describeValidationIssues(undefined)).toEqual([]);
});

it('lists the reasons under the failure instead of "Request validation failed"', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const error = new ApiError(
    422,
    'VALIDATION_FAILED',
    'Request validation failed',
    issues.slice(0, 1),
  );
  await act(async () =>
    root.render(<MutationError error={error} message="The provider could not be saved." />),
  );
  expect(container.textContent).toContain('The provider could not be saved.');
  expect(container.textContent).toContain('Label must be at most 80 characters.');
  expect(container.textContent).not.toContain('Request validation failed');
  await act(async () => root.unmount());
});

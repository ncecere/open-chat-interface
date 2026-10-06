// @vitest-environment happy-dom
import { updateRetentionSettingsSchema, upsertQuotaPolicySchema } from '@oci/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { MutationError } from '../../src/components/admin/admin-ui';
import { ApiError, apiErrorMessage } from '../../src/lib/api-client';
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
    message: 'Invalid email address',
  },
  {
    code: 'invalid_format',
    path: ['actions', 0],
    origin: 'string',
    format: 'regex',
    message: 'Invalid string: must match pattern /^[a-z.*]+$/',
  },
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

it('keeps a message the schema wrote, in the form’s own words for the field (#127)', () => {
  // A refine's own sentence, not "Display timezone Use an IANA ….".
  expect(
    describeValidationIssues(
      [
        {
          code: 'custom',
          path: ['displayTimezone'],
          message: 'Use an IANA time zone such as Europe/London or America/New_York.',
        },
      ],
      { displayTimezone: 'Reporting timezone' },
    ),
  ).toEqual([
    'Reporting timezone: Use an IANA time zone such as Europe/London or America/New_York.',
  ]);
});

it('says "more than 0" for a positive number, and rewords Zod’s bare "Invalid input"', () => {
  const result = upsertQuotaPolicySchema.safeParse({
    name: 'Walk3',
    metric: 'messages',
    limitValue: 0,
    windowKind: 'daily',
  });
  expect(result.success).toBe(false);
  expect(describeValidationIssues(result.error?.issues)).toEqual([
    'Limit value must be more than 0.',
  ]);
  // A production bundle drops Zod's English messages, leaving "Invalid input".
  expect(
    describeValidationIssues([
      { code: 'invalid_value', path: ['metric'], message: 'Invalid input' },
    ]),
  ).toEqual(['Metric is not one of the allowed choices.']);
});

it('apiErrorMessage lists the reasons instead of "Request validation failed" (#127)', () => {
  const error = new ApiError(422, 'VALIDATION_FAILED', 'Request validation failed', [
    { code: 'too_big', path: ['keepDaily'], origin: 'number', maximum: 90, inclusive: true },
  ]);
  expect(apiErrorMessage(error, 'Not saved.', { keepDaily: 'Daily backups kept' })).toBe(
    'Daily backups kept must be at most 90.',
  );
  expect(apiErrorMessage(new ApiError(409, 'CONFLICT', 'Already exists.'), 'Not saved.')).toBe(
    'Already exists.',
  );
  expect(apiErrorMessage(new Error('offline'), 'Not saved.')).toBe('Not saved.');
});

it('says what kind of value to enter, from what the schema expected (#347)', () => {
  // The real schema's refusals: a fraction for a whole number, text for a number.
  const retention = updateRetentionSettingsSchema.safeParse({ memoryRetentionDays: 1.5 });
  expect(
    describeValidationIssues(retention.error?.issues, { memoryRetentionDays: 'Memory' }),
  ).toEqual(['Memory must be a whole number.']);
  const wire = (expected: string, message = 'Invalid input') => [
    { code: 'invalid_type', expected, path: ['field'], message },
  ];
  expect(describeValidationIssues(wire('number'))).toEqual(['Field must be a number.']);
  expect(describeValidationIssues(wire('string'))).toEqual(['Field must be text.']);
  expect(describeValidationIssues(wire('boolean'))).toEqual(['Field must be on or off.']);
  // Nothing was sent: Zod's English says so; the bundle's bare wording cannot.
  expect(
    describeValidationIssues(wire('string', 'Invalid input: expected string, received undefined')),
  ).toEqual(['Field is required.']);
  expect(describeValidationIssues(wire('object'))).toEqual([
    'Field is missing or not the right kind of value.',
  ]);
});

it('rewords the model form’s bare "Invalid input" from the issue (#347)', async () => {
  const { modelFieldProblems } = await import('../../src/components/admin/model-form-draft');
  // As a production bundle reports them: the schema's wording is gone.
  const bare = [
    { path: ['sortOrder'], code: 'invalid_type', message: 'Invalid input', expected: 'number' },
    {
      path: ['inputPriceMicros'],
      code: 'too_small',
      message: 'Invalid input',
      origin: 'number',
      minimum: 0,
      inclusive: true,
    },
  ];
  expect(
    modelFieldProblems(bare as unknown as Parameters<typeof modelFieldProblems>[0]).map(
      (problem) => problem.text,
    ),
  ).toEqual(['Sort order must be a number.', 'Input price must be at least 0.']);
});

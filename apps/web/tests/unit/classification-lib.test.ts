import type { CatalogModel, ClassificationClass, ClassificationResponse } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import {
  availabilityOf,
  blockedDetailsOf,
  blockedSlugs,
  countOf,
  isClassifying,
  listNames,
  notApprovedText,
  reasonTexts,
  warnedText,
  warnNoteText,
  whyNotRemovable,
} from '../../src/lib/classification';
import { startingModelAmong } from '../../src/lib/starting-model';

const klass = (overrides: Partial<ClassificationClass> = {}): ClassificationClass => ({
  id: 'c1',
  name: 'Student records',
  reasons: ['project'],
  ...overrides,
});

describe('listNames and countOf', () => {
  it('joins names the way a sentence does', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('counts with the right noun, and says nothing for none', () => {
    expect(countOf(1, 'project')).toBe('1 project');
    expect(countOf(3, 'project')).toBe('3 projects');
    expect(countOf(0, 'project')).toBeNull();
  });
});

describe('why a conversation carries a class', () => {
  it('says "from the project", and that an administrator set it', () => {
    expect(reasonTexts(klass(), 'thread')).toEqual(['from the project']);
    expect(reasonTexts(klass({ locked: true }), 'thread')).toEqual([
      'from the project, set by an administrator',
    ]);
  });

  it('names the connector, or several, or none', () => {
    const connector = klass({ reasons: ['connector'] });
    expect(reasonTexts({ ...connector, connectorNames: ['SIS'] }, 'thread')).toEqual([
      'from the SIS connector',
    ]);
    expect(reasonTexts({ ...connector, connectorNames: ['SIS', 'Docs'] }, 'thread')).toEqual([
      'from the SIS and Docs connectors',
    ]);
    expect(reasonTexts(connector, 'thread')).toEqual(['from a connector']);
  });

  it('says "added by you" for the person’s own label', () => {
    expect(reasonTexts(klass({ reasons: ['person'] }), 'thread')).toEqual(['added by you']);
  });

  it('says where a kept label came from', () => {
    const kept = klass({ reasons: ['kept'] });
    expect(reasonTexts({ ...kept, origins: ['project'] }, 'thread')).toEqual([
      'kept from its earlier project',
    ]);
    expect(reasonTexts({ ...kept, origins: ['connector: SIS'] }, 'thread')).toEqual([
      'kept from the removed SIS connector',
    ]);
    expect(reasonTexts({ ...kept, origins: ['project', 'connector: SIS'] }, 'thread')).toEqual([
      'kept from its earlier project and the removed SIS connector',
    ]);
    expect(reasonTexts(kept, 'thread')).toEqual(['kept from before']);
  });

  it('lists every reason a class has', () => {
    expect(
      reasonTexts(klass({ reasons: ['project', 'person'], connectorNames: [] }), 'thread'),
    ).toEqual(['from the project', 'added by you']);
  });

  it('on a project, the owner’s label is theirs and an administrator’s is locked', () => {
    expect(reasonTexts(klass(), 'project')).toEqual(['added by you']);
    expect(reasonTexts(klass({ locked: true }), 'project')).toEqual(['set by an administrator']);
  });

  it('explains in a sentence why a label cannot be removed', () => {
    expect(whyNotRemovable(klass({ reasons: ['project'] }), 'thread')).toContain(
      'comes from the project',
    );
    expect(whyNotRemovable(klass({ reasons: ['connector'] }), 'thread')).toContain(
      'comes from a connector',
    );
    expect(whyNotRemovable(klass({ reasons: ['kept'] }), 'thread')).toContain('was kept');
    expect(whyNotRemovable(klass({ locked: true }), 'project')).toContain('only an administrator');
  });
});

const response = (overrides: Partial<ClassificationResponse> = {}): ClassificationResponse => ({
  mode: 'block',
  classes: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
  models: [
    { slug: 'ok', displayName: 'Approved', status: 'ok', missing: [] },
    {
      slug: 'no',
      displayName: 'Plain',
      status: 'blocked',
      missing: [{ id: 'c1', name: 'Student records' }],
    },
  ],
  ...overrides,
});

describe('what the server says about models', () => {
  it('is on only in warn and block', () => {
    expect(isClassifying(response())).toBe(true);
    expect(isClassifying(response({ mode: 'warn' }))).toBe(true);
    expect(isClassifying(response({ mode: 'off' }))).toBe(false);
    expect(isClassifying(undefined)).toBe(false);
    // An answer that is not one (a mocked query's other data) is not on.
    expect(isClassifying({ thread: {} } as unknown as ClassificationResponse)).toBe(false);
  });

  it('maps models by slug, and has none while off', () => {
    expect(availabilityOf(response()).get('no')?.status).toBe('blocked');
    expect(availabilityOf(response({ mode: 'off' })).size).toBe(0);
    expect(availabilityOf(undefined).size).toBe(0);
  });

  it('names the models block forbids, and none in warn', () => {
    expect([...blockedSlugs(response())]).toEqual(['no']);
    expect(blockedSlugs(response({ mode: 'warn' })).size).toBe(0);
    expect(blockedSlugs(undefined).size).toBe(0);
  });

  it('puts the missing classes in the picker’s words', () => {
    const [, plain] = response().models;
    expect(notApprovedText(plain!)).toBe('Not approved for Student records');
    expect(warnNoteText(plain!)).toBe(
      'Not approved for Student records. You can still use it; the administrator is told.',
    );
  });
});

describe('a refused send', () => {
  const details = {
    point: 'send',
    model: { slug: 'no', displayName: 'Plain' },
    missing: [{ id: 'c1', name: 'Student records', reasons: ['project'] }],
    approvedModels: [{ slug: 'ok', displayName: 'Approved' }],
  };

  it('reads the details from an API error', () => {
    const error = new ApiError(403, 'DATA_CLASS_BLOCKED', 'Your message was not sent.', details);
    expect(blockedDetailsOf(error)?.approvedModels).toEqual([
      { slug: 'ok', displayName: 'Approved' },
    ]);
  });

  it('reads them from the chat stream’s error, whose message is the response body', () => {
    const error = new Error(
      JSON.stringify({ error: { code: 'DATA_CLASS_BLOCKED', message: 'No.', details } }),
    );
    expect(blockedDetailsOf(error)?.point).toBe('send');
  });

  it('ignores every other error', () => {
    expect(blockedDetailsOf(new ApiError(403, 'FORBIDDEN', 'No.', details))).toBeNull();
    expect(blockedDetailsOf(new Error('Failed to fetch'))).toBeNull();
    expect(
      blockedDetailsOf(new Error(JSON.stringify({ error: { code: 'RATE_LIMITED' } }))),
    ).toBeNull();
    expect(blockedDetailsOf('boom')).toBeNull();
    // A body that is not the documented shape is not trusted.
    expect(blockedDetailsOf(new ApiError(403, 'DATA_CLASS_BLOCKED', 'No.', { point: 'x' }))).toBe(
      null,
    );
  });
});

describe('the notice on a reply sent in warn', () => {
  const part = (point: Parameters<typeof warnedText>[0]['point']) =>
    warnedText({ mode: 'warn', point, missing: ['Student records', 'Health data'] });

  it('says what the conversation carries, in the person’s words, for every place', () => {
    for (const point of [
      'send',
      'approval',
      'tool',
      'compaction',
      'web_search',
      'embedding',
      'rerank',
      'share',
    ] as const) {
      expect(part(point)).toContain('Student records and Health data');
    }
    expect(part('send')).toContain('sent anyway');
    expect(part('share')).toContain('anyone who has it');
  });
});

describe('the model a conversation starts on', () => {
  const model = (slug: string, isDefault = false) =>
    ({ id: slug, slug, displayName: slug, isDefault }) as CatalogModel;
  const models = [model('plain', true), model('approved'), model('other')];

  it('does not pick an unapproved default', () => {
    expect(startingModelAmong(models, new Set(['plain']), null)?.slug).toBe('approved');
    // The person's own default is skipped too, while it is forbidden.
    expect(startingModelAmong(models, new Set(['plain', 'approved']), null, 'plain')?.slug).toBe(
      'other',
    );
    expect(startingModelAmong(models, new Set(['plain']), null, 'other')?.slug).toBe('other');
  });

  it('keeps a choice already made, even a forbidden one, so the person decides', () => {
    expect(startingModelAmong(models, new Set(['plain']), 'plain')?.slug).toBe('plain');
  });

  it('falls back to the ordinary default when nothing is approved', () => {
    expect(startingModelAmong(models, new Set(['plain', 'approved', 'other']), null)?.slug).toBe(
      'plain',
    );
  });

  it('is the ordinary choice when nothing is forbidden', () => {
    expect(startingModelAmong(models, new Set(), null)?.slug).toBe('plain');
    expect(startingModelAmong(models, new Set(), 'gone', 'other')?.slug).toBe('other');
    expect(startingModelAmong([], new Set(), null)).toBeNull();
  });
});

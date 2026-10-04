import { describe, expect, it } from 'vitest';
import { type WorkStep, workActivity, workSummary } from '../../src/components/chat/work-summary';

const step = (toolId: string, extra: Partial<WorkStep> = {}): WorkStep => ({
  toolId,
  label: toolId,
  state: 'done',
  ...extra,
});
const search = step('web_search');
const create = step('create_artifact');

describe('the work block summary', () => {
  it('says "Thought" for reasoning alone, with the time when known', () => {
    expect(workSummary({ reasoning: true, steps: [] })).toBe('Thought');
    expect(workSummary({ reasoning: true, steps: [], seconds: 6.4 })).toBe('Thought for 6s');
    // Under a second, or unknown, the time is left out.
    expect(workSummary({ reasoning: true, steps: [], seconds: 0.2 })).toBe('Thought');
    expect(workSummary({ reasoning: true, steps: [], seconds: null })).toBe('Thought');
  });

  it('names one kind of tool use after the reasoning', () => {
    expect(workSummary({ reasoning: true, steps: [create], seconds: 14 })).toBe(
      'Thought for 14s · created an artifact',
    );
    expect(workSummary({ reasoning: true, steps: [create] })).toBe('Thought · created an artifact');
    expect(workSummary({ reasoning: true, steps: [search, search], seconds: 9 })).toBe(
      'Thought for 9s · searched the web twice',
    );
    expect(workSummary({ reasoning: true, steps: [search, search, search] })).toBe(
      'Thought · searched the web 3 times',
    );
    expect(
      workSummary({
        reasoning: true,
        steps: [step('mcp__desk__lookup', { label: 'Service Desk lookup' })],
        seconds: 3,
      }),
    ).toBe('Thought for 3s · used Service Desk lookup');
    expect(workSummary({ reasoning: true, steps: [create, create] })).toBe(
      'Thought · created 2 artifacts',
    );
  });

  it('tells repeated revisions of one artifact from revisions of several', () => {
    const update = (target: string | null) => step('update_artifact', { target });
    expect(workSummary({ reasoning: true, steps: [update('a')] })).toBe(
      'Thought · updated an artifact',
    );
    expect(workSummary({ reasoning: true, steps: [update('a'), update('a')] })).toBe(
      'Thought · updated an artifact twice',
    );
    expect(workSummary({ reasoning: true, steps: [update('a'), update('b')] })).toBe(
      'Thought · updated 2 artifacts',
    );
    expect(workSummary({ reasoning: true, steps: [update(null), update(null)] })).toBe(
      'Thought · updated 2 artifacts',
    );
  });

  it('starts with the activity when there was no reasoning', () => {
    expect(workSummary({ reasoning: false, steps: [search, search] })).toBe(
      'Searched the web twice',
    );
    expect(workSummary({ reasoning: false, steps: [step('x', { label: 'Send note' })] })).toBe(
      'Used Send note',
    );
    expect(workSummary({ reasoning: false, steps: [step('remember')] })).toBe('Saved a memory');
    expect(workSummary({ reasoning: false, steps: [step('forget'), step('forget')] })).toBe(
      'Removed 2 memories',
    );
  });

  it('counts the steps when the work was mixed', () => {
    expect(workSummary({ reasoning: true, steps: [search, search, create], seconds: 12 })).toBe(
      'Worked for 12s · 3 steps',
    );
    expect(workSummary({ reasoning: false, steps: [search, create] })).toBe('Worked · 2 steps');
    // Two different tools are two kinds.
    expect(
      workSummary({
        reasoning: true,
        steps: [step('a', { label: 'A' }), step('b', { label: 'B' })],
      }),
    ).toBe('Worked · 2 steps');
  });

  it('does not claim what failed or was not run', () => {
    expect(workSummary({ reasoning: true, steps: [{ ...create, state: 'error' }] })).toBe(
      'Thought · a step failed',
    );
    expect(workSummary({ reasoning: false, steps: [{ ...search, state: 'denied' }] })).toBe(
      'A step was not run',
    );
    expect(workSummary({ reasoning: false, steps: [search, { ...search, state: 'error' }] })).toBe(
      'Worked · 2 steps',
    );
  });
});

describe('the current activity', () => {
  it('names what the model is doing, and a brief form without names for announcements', () => {
    expect(workActivity({ type: 'reasoning' })).toEqual({
      label: 'Thinking…',
      brief: 'Thinking',
    });
    expect(workActivity({ type: 'tool', step: { ...search, state: 'running' } }).label).toBe(
      'Searching the web…',
    );
    const writing = workActivity({
      type: 'tool',
      step: { ...create, state: 'running' },
      title: 'Sales chart',
    });
    expect(writing).toEqual({ label: 'Writing Sales chart…', brief: 'Writing an artifact' });
    expect(
      workActivity({ type: 'tool', step: { ...create, state: 'running' }, title: null }).label,
    ).toBe('Writing an artifact…');
    expect(
      workActivity({
        type: 'tool',
        step: step('update_artifact', { state: 'running' }),
        title: 'Plan',
      }).label,
    ).toBe('Revising Plan…');
    expect(
      workActivity({ type: 'tool', step: step('x', { label: 'Send note', state: 'running' }) })
        .label,
    ).toBe('Using Send note…');
    expect(
      workActivity({ type: 'tool', step: step('x', { state: 'awaiting-approval' }) }).label,
    ).toBe('Waiting for your approval…');
    // A finished call, before the next step starts.
    expect(workActivity({ type: 'tool', step: search }).label).toBe('Working…');
    expect(workActivity({ type: 'between' }).label).toBe('Working…');
  });
});

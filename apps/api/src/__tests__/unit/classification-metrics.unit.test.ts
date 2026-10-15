import { beforeEach, describe, expect, it } from 'vitest';
import { observeClassificationDecision } from '../../services/observability/events.js';
import { classificationDecisions, resetMetrics } from '../../services/observability/metrics.js';

/**
 * The decisions counter's labels come from fixed vocabularies, so a new call
 * site that passes something else (a class name, a model, a person) cannot
 * create a series per value: it is counted as `other` (SPEC-data-classification.md,
 * "Audit and metrics": no class names in metric labels, bounded cardinality).
 */
describe('classification decision metric', () => {
  beforeEach(() => resetMetrics());

  it('counts the known points and outcomes as they are', () => {
    observeClassificationDecision('send', 'blocked');
    observeClassificationDecision('tool', 'warned');
    expect(classificationDecisions.get({ point: 'send', outcome: 'blocked' })).toBe(1);
    expect(classificationDecisions.get({ point: 'tool', outcome: 'warned' })).toBe(1);
  });

  it('counts anything else as other, never as a new label value', () => {
    observeClassificationDecision('Student records', 'blocked');
    observeClassificationDecision('send', 'a person@example.com');
    observeClassificationDecision('x', 'y');
    expect(classificationDecisions.get({ point: 'other', outcome: 'blocked' })).toBe(1);
    expect(classificationDecisions.get({ point: 'send', outcome: 'other' })).toBe(1);
    expect(classificationDecisions.get({ point: 'other', outcome: 'other' })).toBe(1);
    expect(classificationDecisions.get({ point: 'Student records', outcome: 'blocked' })).toBe(0);
  });
});

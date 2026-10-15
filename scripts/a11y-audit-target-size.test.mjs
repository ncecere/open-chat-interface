import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  circleIntersectsRect,
  evaluateTargets,
  MINIMUM_TARGET,
} from './a11y-audit/lib/target-size.mjs';

const box = (id, x, y, width, height, extra = {}) => ({
  id,
  rect: { x, y, width, height },
  ...extra,
});
const byId = (results, id) => results.find((result) => result.id === id);

test('the minimum is 24 CSS px', () => {
  assert.equal(MINIMUM_TARGET, 24);
});

test('a target of 24 by 24 or more passes on size alone', () => {
  const { results, failures } = evaluateTargets([
    box('a', 0, 0, 24, 24),
    box('b', 0, 24, 100, 44),
    // Right next to each other: size is enough, spacing is not looked at.
    box('c', 100, 24, 24, 24),
  ]);
  assert.equal(failures.length, 0);
  assert.equal(byId(results, 'a').exception, 'size');
});

test('one pixel short on either side is undersized', () => {
  const { results } = evaluateTargets([box('narrow', 0, 0, 23, 30), box('short', 200, 0, 30, 23)]);
  // Alone on the page, so the spacing exception applies, and it is named.
  assert.equal(byId(results, 'narrow').exception, 'spacing');
  assert.equal(byId(results, 'short').exception, 'spacing');
});

test('a 10px button with room around it passes by spacing; with a neighbour 4px away it fails', () => {
  const alone = evaluateTargets([box('small', 100, 100, 10, 10)]);
  assert.equal(alone.failures.length, 0);

  // Two 16px controls 4px apart: their 24px circles overlap.
  const crowded = evaluateTargets([box('x', 0, 0, 16, 16), box('y', 20, 0, 16, 16)]);
  assert.deepEqual(crowded.failures.map((failure) => failure.id).sort(), ['x', 'y']);

  // 8px apart: the centres are exactly 24px apart, the circles touch but do not intersect.
  const spaced = evaluateTargets([box('x', 0, 0, 16, 16), box('y', 24, 0, 16, 16)]);
  assert.equal(spaced.failures.length, 0);
});

test('an undersized target whose circle reaches a full-size neighbour fails', () => {
  const { failures } = evaluateTargets([box('icon', 0, 0, 16, 16), box('big', 18, 0, 120, 44)]);
  // The icon's circle (centre 8,8; radius 12) reaches x=20, inside the neighbour starting at 18.
  assert.deepEqual(
    failures.map((failure) => failure.id),
    ['icon'],
  );
  assert.match(failures[0].reason, /big/);
});

test('the neighbour that is large enough is never failed by the small one', () => {
  const { results } = evaluateTargets([box('icon', 0, 0, 16, 16), box('big', 18, 0, 120, 44)]);
  assert.equal(byId(results, 'big').pass, true);
});

test('an inline link and a native control are exceptions, and named as such', () => {
  const { results, failures } = evaluateTargets([
    box('link', 0, 0, 60, 14, { inline: true }),
    box('check', 0, 20, 13, 13, { userAgent: true }),
    // A neighbour inside both circles does not turn an exception into a failure.
    box('near', 14, 0, 14, 14),
  ]);
  assert.equal(byId(results, 'link').exception, 'inline');
  assert.equal(byId(results, 'check').exception, 'user-agent');
  assert.deepEqual(
    failures.map((failure) => failure.id),
    ['near'],
  );
});

test('a control inside another control is not its neighbour', () => {
  // A 16px clear button inside a 200 by 40 field: the field contains it.
  const { failures } = evaluateTargets([
    box('field', 0, 0, 200, 40, { containerIds: [] }),
    box('clear', 170, 12, 16, 16, { containerIds: ['field'] }),
  ]);
  assert.equal(failures.length, 0);
});

test('a target with no area is reported, not silently passed', () => {
  const { failures } = evaluateTargets([box('zero', 10, 10, 0, 0)]);
  assert.equal(failures.length, 0);
  assert.equal(evaluateTargets([box('zero', 10, 10, 0, 0)]).skipped.length, 1);
});

test('circle and rectangle intersection, on known geometry', () => {
  const rect = { x: 10, y: 0, width: 10, height: 10 };
  assert.equal(circleIntersectsRect({ x: 0, y: 5 }, 12, rect), true);
  // Exactly touching is not intersecting.
  assert.equal(circleIntersectsRect({ x: 0, y: 5 }, 10, rect), false);
  assert.equal(circleIntersectsRect({ x: 0, y: 5 }, 9, rect), false);
  // Near a corner: distance to (10,0) from (0,-3) is sqrt(109) = 10.44.
  assert.equal(circleIntersectsRect({ x: 0, y: -3 }, 12, rect), true);
  assert.equal(circleIntersectsRect({ x: 0, y: -3 }, 10, rect), false);
  // The centre inside the rectangle.
  assert.equal(circleIntersectsRect({ x: 15, y: 5 }, 1, rect), true);
});

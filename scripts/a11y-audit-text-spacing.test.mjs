import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findNewClipping,
  findNewOverlaps,
  intersectionArea,
  TEXT_SPACING_CSS,
} from './a11y-audit/lib/text-spacing.mjs';

const element = (id, over = {}) => ({
  id,
  clientWidth: 200,
  clientHeight: 40,
  scrollWidth: 200,
  scrollHeight: 40,
  overflowX: 'visible',
  overflowY: 'visible',
  ...over,
});

test('the injected CSS is the WCAG 1.4.12 override, in its four parts', () => {
  assert.match(TEXT_SPACING_CSS, /line-height:\s*1\.5\s*!important/);
  assert.match(TEXT_SPACING_CSS, /letter-spacing:\s*0\.12em\s*!important/);
  assert.match(TEXT_SPACING_CSS, /word-spacing:\s*0\.16em\s*!important/);
  assert.match(TEXT_SPACING_CSS, /margin-bottom:\s*2em\s*!important/);
});

test('text that no longer fits a box that hides its overflow is clipping', () => {
  const before = [element('title', { overflowY: 'hidden' })];
  const after = [element('title', { overflowY: 'hidden', scrollHeight: 72 })];
  const clipped = findNewClipping(before, after);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].id, 'title');
  assert.equal(clipped[0].axis, 'y');
  assert.equal(clipped[0].hiddenPx, 32);
});

test('a box that could scroll or grow is not clipping', () => {
  const grown = [element('card', { clientHeight: 80, scrollHeight: 80 })];
  const scrolling = [element('log', { overflowY: 'auto', scrollHeight: 400 })];
  assert.deepEqual(findNewClipping(grown, grown), []);
  assert.deepEqual(findNewClipping(scrolling, scrolling), []);
});

test('content that was already cut off before the override is not blamed on it', () => {
  const same = [element('blurb', { overflowY: 'hidden', scrollHeight: 60 })];
  assert.deepEqual(findNewClipping(same, same), []);
  // But more of it cut off now is the override's doing.
  const worse = [element('blurb', { overflowY: 'hidden', scrollHeight: 96 })];
  const found = findNewClipping(same, worse);
  assert.equal(found.length, 1);
  assert.equal(found[0].hiddenPx, 56);
});

test('one pixel of rounding is not clipping', () => {
  const after = [element('t', { overflowX: 'clip', scrollWidth: 201 })];
  assert.deepEqual(findNewClipping([element('t', { overflowX: 'clip' })], after), []);
});

test('horizontal clipping is reported on the x axis', () => {
  const after = [element('chip', { overflowX: 'hidden', scrollWidth: 260 })];
  const found = findNewClipping([element('chip', { overflowX: 'hidden' })], after);
  assert.equal(found[0].axis, 'x');
  assert.equal(found[0].hiddenPx, 60);
});

test('intersection area of known boxes', () => {
  assert.equal(
    intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    25,
  );
  assert.equal(
    intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }),
    0,
  );
  assert.equal(
    intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 5, height: 5 }),
    0,
  );
});

test('two lines of text that now overlap are reported; ones that already did are not', () => {
  const before = [
    { id: 'a', rect: { x: 0, y: 0, width: 100, height: 20 } },
    { id: 'b', rect: { x: 0, y: 24, width: 100, height: 20 } },
  ];
  const after = [
    { id: 'a', rect: { x: 0, y: 0, width: 100, height: 30 } },
    { id: 'b', rect: { x: 0, y: 24, width: 100, height: 20 } },
  ];
  const found = findNewOverlaps(before, after);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].first, found[0].second], ['a', 'b']);
  assert.equal(found[0].area, 600);

  // Overlapping before and after is not new.
  assert.deepEqual(findNewOverlaps(after, after), []);
});

test('a parent and the text inside it are not an overlap', () => {
  const rows = [
    { id: 'row', rect: { x: 0, y: 0, width: 300, height: 40 } },
    { id: 'label', rect: { x: 10, y: 10, width: 80, height: 20 }, ancestorIds: ['row'] },
  ];
  assert.deepEqual(findNewOverlaps([], rows), []);
});

test('a sliver of overlap is below the tolerance', () => {
  const after = [
    { id: 'a', rect: { x: 0, y: 0, width: 100, height: 21 } },
    { id: 'b', rect: { x: 0, y: 20, width: 100, height: 20 } },
  ];
  // One pixel high by 100 wide is 100 px2, 5% of the smaller box: line-box rounding, not collision.
  assert.deepEqual(findNewOverlaps([], after), []);
});

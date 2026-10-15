/**
 * WCAG 1.4.12 Text Spacing, as pure functions of measurements.
 *
 * The browser step (checks/text-spacing.mjs) measures every text-bearing element before and
 * after injecting TEXT_SPACING_CSS and hands the two lists here. A failure is something the
 * override newly did: text clipped by a box that hides its overflow, or text boxes that now
 * overlap. Problems that were there before the override are other criteria's business.
 */

/**
 * The four properties 1.4.12 names, at the values it says content must tolerate: line height
 * 1.5 times the font size, paragraph spacing 2 times, letter spacing 0.12 times, word spacing
 * 0.16 times.
 */
export const TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p {
    margin-bottom: 2em !important;
  }
`;

// Sub-pixel layout and line-box rounding.
const CLIP_TOLERANCE_PX = 1;
const MINIMUM_OVERLAP_PX2 = 4;
const MINIMUM_OVERLAP_SHARE = 0.15;

const hides = (overflow) => overflow === 'hidden' || overflow === 'clip';

function hiddenExtent(record) {
  return {
    x: hides(record.overflowX) ? Math.max(0, record.scrollWidth - record.clientWidth) : 0,
    y: hides(record.overflowY) ? Math.max(0, record.scrollHeight - record.clientHeight) : 0,
  };
}

/**
 * Elements whose overflow is hidden and now hide more than before.
 *
 * @param {Array<{ id: string, clientWidth: number, clientHeight: number, scrollWidth: number, scrollHeight: number, overflowX: string, overflowY: string }>} before
 * @param {typeof before} after
 */
export function findNewClipping(before, after) {
  const earlier = new Map(before.map((record) => [record.id, hiddenExtent(record)]));
  const found = [];
  for (const record of after) {
    const now = hiddenExtent(record);
    const was = earlier.get(record.id) ?? { x: 0, y: 0 };
    for (const axis of ['x', 'y']) {
      if (now[axis] > CLIP_TOLERANCE_PX && now[axis] > was[axis] + CLIP_TOLERANCE_PX) {
        found.push({ id: record.id, axis, hiddenPx: Math.round(now[axis]) });
      }
    }
  }
  return found;
}

/** Area shared by two `{ x, y, width, height }` boxes. */
export function intersectionArea(one, two) {
  const width = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
  const height = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Pairs of text boxes that overlap after the override and did not before. A box and the box
 * of an ancestor it sits in are not a pair. Overlap smaller than a sliver of the smaller box
 * is line-box rounding, not a collision.
 *
 * @param {Array<{ id: string, rect: { x: number, y: number, width: number, height: number }, ancestorIds?: string[] }>} before
 * @param {typeof before} after
 */
export function findNewOverlaps(before, after) {
  const earlier = new Map(before.map((record) => [record.id, record.rect]));
  const found = [];
  for (let i = 0; i < after.length; i += 1) {
    for (let j = i + 1; j < after.length; j += 1) {
      const one = after[i];
      const two = after[j];
      if (one.ancestorIds?.includes(two.id) || two.ancestorIds?.includes(one.id)) continue;
      const area = intersectionArea(one.rect, two.rect);
      if (area < MINIMUM_OVERLAP_PX2) continue;
      const smaller = Math.min(one.rect.width * one.rect.height, two.rect.width * two.rect.height);
      if (smaller === 0 || area / smaller < MINIMUM_OVERLAP_SHARE) continue;
      const wasOne = earlier.get(one.id);
      const wasTwo = earlier.get(two.id);
      if (wasOne && wasTwo && intersectionArea(wasOne, wasTwo) >= MINIMUM_OVERLAP_PX2) continue;
      found.push({ first: one.id, second: two.id, area: Math.round(area) });
    }
  }
  return found;
}

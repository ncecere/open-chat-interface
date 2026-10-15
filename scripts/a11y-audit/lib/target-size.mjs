/**
 * WCAG 2.5.8 Target Size (Minimum), as a pure function of boxes.
 *
 * A target passes when it is at least 24 by 24 CSS px, or when it is undersized and one of the
 * exceptions applies. This module decides the three that geometry can decide (spacing, inline,
 * user agent). "Equivalent" and "essential" need a person: a failure here is a candidate that
 * report.mjs says may still carry one of them.
 *
 * A target is `{ id, rect: { x, y, width, height }, inline?, userAgent?, containerIds? }`.
 * `containerIds` are the ids of the targets that contain this one in the DOM (a clear button
 * inside a field): a control is not the neighbour of the control it sits in.
 */

export const MINIMUM_TARGET = 24;
const RADIUS = MINIMUM_TARGET / 2;
// Layout gives fractions: 23.996 is a 24px target.
const EPSILON = 0.01;

const centre = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/** Whether a circle and a rectangle overlap; touching at one point is not overlapping. */
export function circleIntersectsRect(point, radius, rect) {
  const nearestX = Math.min(Math.max(point.x, rect.x), rect.x + rect.width);
  const nearestY = Math.min(Math.max(point.y, rect.y), rect.y + rect.height);
  return Math.hypot(point.x - nearestX, point.y - nearestY) < radius - EPSILON;
}

const isLargeEnough = (rect) =>
  rect.width >= MINIMUM_TARGET - EPSILON && rect.height >= MINIMUM_TARGET - EPSILON;

/**
 * @param {Array<{ id: string, rect: {x:number,y:number,width:number,height:number}, inline?: boolean, userAgent?: boolean, containerIds?: string[] }>} targets
 * @returns {{ results: Array<{ id: string, pass: boolean, exception: string | null, width: number, height: number, reason?: string }>, failures: Array<object>, skipped: Array<{ id: string }> }}
 */
export function evaluateTargets(targets) {
  const measured = [];
  const skipped = [];
  for (const target of targets) {
    if (target.rect.width <= 0 || target.rect.height <= 0) skipped.push({ id: target.id });
    else measured.push(target);
  }

  const related = (one, two) =>
    (one.containerIds ?? []).includes(two.id) || (two.containerIds ?? []).includes(one.id);

  const results = measured.map((target) => {
    const { width, height } = target.rect;
    const base = { id: target.id, width, height };
    if (isLargeEnough(target.rect)) return { ...base, pass: true, exception: 'size' };
    if (target.userAgent) return { ...base, pass: true, exception: 'user-agent' };
    if (target.inline) return { ...base, pass: true, exception: 'inline' };

    // Spacing: a 24px circle on this target's centre meets no other target and no other
    // undersized target's circle.
    const here = centre(target.rect);
    for (const other of measured) {
      if (other === target || related(target, other)) continue;
      if (circleIntersectsRect(here, RADIUS, other.rect)) {
        return {
          ...base,
          pass: false,
          exception: null,
          reason: `${Math.round(width)}x${Math.round(height)} px and within 12 px of ${other.id}`,
        };
      }
      if (!isLargeEnough(other.rect)) {
        const there = centre(other.rect);
        if (Math.hypot(here.x - there.x, here.y - there.y) < RADIUS * 2 - EPSILON) {
          return {
            ...base,
            pass: false,
            exception: null,
            reason: `${Math.round(width)}x${Math.round(height)} px and its 24 px circle meets that of ${other.id}`,
          };
        }
      }
    }
    return { ...base, pass: true, exception: 'spacing' };
  });

  return { results, failures: results.filter((result) => !result.pass), skipped };
}

/**
 * Step 2 of the Method, the primitives: walking the tab order with `page.keyboard` only and
 * judging every stop. The walkthroughs of the primary tasks (walkthroughs.mjs) use these.
 *
 * Per stop: whether a focus indicator is drawn (2.4.7) and whether it contrasts with what is
 * beside it (1.4.11), whether something fixed or sticky covers the focused element (2.4.11),
 * whether it is on screen at all. Over the walk: whether focus gets stuck (2.1.2).
 */

import {
  effectiveBackground,
  evaluateNonTextContrast,
  parseColour,
  toHex,
} from '../lib/colour.mjs';

/** Runs in the page: what has focus, how it is drawn, and what is on top of it. */
function snapshotFocus() {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) {
    return {
      end: true,
      dialogOpen: Boolean(
        document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]'),
      ),
    };
  }
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const label = (
    element.getAttribute('aria-label') ||
    (element.getAttribute('aria-labelledby')
      ? document.getElementById(element.getAttribute('aria-labelledby').split(' ')[0])?.textContent
      : '') ||
    element.textContent ||
    element.getAttribute('placeholder') ||
    element.tagName
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  const path = [
    element.tagName.toLowerCase(),
    ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
  ].join('.');

  const drawn = (computed) => ({
    outlineStyle: computed.outlineStyle,
    outlineWidth: Number.parseFloat(computed.outlineWidth),
    outlineColor: computed.outlineColor,
    outlineOffset: computed.outlineOffset,
    boxShadow: computed.boxShadow,
  });
  const own = drawn(style);
  // A control may hand its indicator to a container that draws it while the control has focus.
  let delegated = null;
  for (
    let node = element.parentElement, depth = 0;
    node && depth < 4;
    node = node.parentElement, depth += 1
  ) {
    if (!node.matches(':focus-within')) continue;
    const container = drawn(getComputedStyle(node));
    if (
      (container.outlineStyle !== 'none' && container.outlineWidth > 0) ||
      container.boxShadow !== 'none'
    ) {
      delegated = container;
      break;
    }
  }

  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const onScreen =
    rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  // Five points inside the box, kept inside the window: the middle and four inset corners.
  const inset = (value, low, high) => Math.min(Math.max(value, low), high);
  const points = [
    [0.5, 0.5],
    [0.1, 0.2],
    [0.9, 0.2],
    [0.1, 0.8],
    [0.9, 0.8],
  ].map(([fx, fy]) => [
    inset(rect.left + rect.width * fx, 1, viewportWidth - 1),
    inset(rect.top + rect.height * fy, 1, viewportHeight - 1),
  ]);
  let covered = 0;
  let coveredBy = null;
  for (const [x, y] of points) {
    const top = document.elementsFromPoint(x, y)[0];
    if (top && !element.contains(top) && !top.contains(element)) {
      covered += 1;
      coveredBy ??= [
        top.tagName.toLowerCase(),
        ...[...top.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
      ].join('.');
    }
  }

  const layers = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (computed.backgroundImage !== 'none') {
      layers.push({ image: true });
      continue;
    }
    if (
      !/^rgba\(.*,\s*0\)$/.test(computed.backgroundColor) &&
      computed.backgroundColor !== 'transparent'
    ) {
      layers.push(computed.backgroundColor);
      if (/^rgb\(/.test(computed.backgroundColor)) break;
    }
  }

  return {
    end: false,
    path,
    label,
    role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
    focusVisible: element.matches(':focus-visible'),
    own,
    delegated,
    onScreen,
    covered,
    points: points.length,
    coveredBy,
    layers,
    positiveTabindex: Number(element.getAttribute('tabindex')) > 0,
    dialogOpen: Boolean(
      document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]'),
    ),
    inDialog: Boolean(element.closest('[role="dialog"], [role="alertdialog"], dialog')),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

/** Whether focusing changes anything the person can see, when no outline or ring is drawn. */
async function changesWhenFocused(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return false;
    const read = () => {
      const style = getComputedStyle(element);
      return [
        style.backgroundColor,
        style.borderTopColor,
        style.color,
        style.textDecorationLine,
        style.transform,
        style.opacity,
      ].join('|');
    };
    const focused = read();
    element.blur();
    const blurred = read();
    element.focus({ focusVisible: true });
    return focused !== blurred;
  });
}

const COLOUR = /(rgba?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\))/;

/** The colour a focus indicator is drawn in: the outline, or else the first shadow. */
function indicatorColour(stop) {
  const source =
    stop.own.outlineStyle !== 'none' && stop.own.outlineWidth > 0
      ? stop.own
      : (stop.delegated ?? stop.own);
  if (source.outlineStyle !== 'none' && source.outlineWidth > 0)
    return parseColour(source.outlineColor);
  const match = COLOUR.exec(source.boxShadow ?? '');
  return match ? parseColour(match[1]) : null;
}

/**
 * Presses Tab until focus leaves the document (or `limit`), judging every stop.
 *
 * @returns {Promise<{ stops: object[], reachedEnd: boolean, trapped: boolean }>}
 */
export async function walkTabs(page, { evidence, route, context, label, limit = 80, startAt }) {
  if (startAt) await page.evaluate(startAt);
  const stops = [];
  const recent = [];
  let reachedEnd = false;
  let trapped = false;
  let stuck = 0;
  let previous = '';
  evidence.sample(['2.4.7', '2.4.11', '2.1.2', '2.4.3'], 'keyboard', route);

  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(snapshotFocus);
    if (stop.end) {
      reachedEnd = true;
      break;
    }
    stops.push(stop);
    const identity = `${stop.path}@${stop.rect.x},${stop.rect.y}`;
    stuck = identity === previous ? stuck + 1 : 0;
    previous = identity;
    recent.push(identity);
    if (recent.length > 30) recent.shift();

    const common = { check: 'keyboard', route, context, targets: [stop.path] };
    const drawn =
      (stop.own.outlineStyle !== 'none' && stop.own.outlineWidth > 0) ||
      stop.own.boxShadow !== 'none' ||
      Boolean(stop.delegated);
    if (!drawn && !(await changesWhenFocused(page))) {
      evidence.finding({
        ...common,
        criteria: ['2.4.7'],
        rule: 'no-focus-indicator',
        severity: 'serious',
        message: `Focus on a ${stop.role} ("${stop.label}") shows no outline, ring or other change`,
      });
    } else if (drawn) {
      const colour = indicatorColour(stop);
      const surrounding = effectiveBackground(stop.layers);
      if (colour && surrounding.determinate) {
        const verdict = evaluateNonTextContrast({ fg: colour, bg: surrounding.colour });
        evidence.count('keyboard', 'indicators-measured', 1);
        if (!verdict.pass) {
          evidence.finding({
            ...common,
            criteria: ['1.4.11'],
            rule: 'focus-indicator-contrast',
            severity: 'moderate',
            message: `The focus indicator ${toHex(colour)} on ${toHex(surrounding.colour)} is ${verdict.ratio.toFixed(2)}:1, needs 3:1`,
          });
        }
      } else {
        evidence.count('keyboard', 'indicators-not-measured', 1);
      }
    }
    if (!stop.onScreen) {
      evidence.finding({
        ...common,
        criteria: ['2.4.7'],
        rule: 'focus-off-screen',
        severity: 'serious',
        message: `Focus moved to a ${stop.role} ("${stop.label}") that is not on screen`,
      });
    } else if (stop.covered === stop.points) {
      evidence.finding({
        ...common,
        criteria: ['2.4.11'],
        rule: 'focus-obscured',
        severity: 'serious',
        message: `The focused ${stop.role} ("${stop.label}") is entirely covered by ${stop.coveredBy}`,
      });
    } else if (stop.covered > 0) {
      evidence.finding({
        ...common,
        criteria: ['2.4.11'],
        rule: 'focus-partly-obscured',
        severity: 'review',
        message: `The focused ${stop.role} ("${stop.label}") is partly covered by ${stop.coveredBy} (${stop.covered} of ${stop.points} points); level AA only fails it when entirely hidden`,
      });
    }
    if (stop.positiveTabindex) {
      evidence.finding({
        ...common,
        criteria: ['2.4.3'],
        rule: 'positive-tabindex',
        severity: 'moderate',
        message: 'A positive tabindex makes the tab order differ from the reading order',
      });
    }
    // A modal's focus loop is correct (Escape leaves it); anywhere else, stuck focus is a trap.
    if (!stop.dialogOpen && (stuck >= 3 || (recent.length >= 30 && new Set(recent).size <= 4))) {
      trapped = true;
      evidence.finding({
        ...common,
        criteria: ['2.1.2'],
        rule: 'keyboard-trap',
        severity: 'critical',
        message: `Tab does not leave the ${stop.role} ("${stop.label}")`,
      });
      break;
    }
  }

  evidence.fact('keyboard', `${label}:${route}`, {
    stops: stops.length,
    reachedEnd,
    trapped,
    order: stops.slice(0, 60).map((stop) => `${stop.role}: ${stop.label}`),
  });
  evidence.limit(
    'keyboard',
    'Focus is judged from computed styles and element hit-testing, not from pixels: an outline that is drawn but invisible (the same colour as the background) is caught by the contrast sum, one that is clipped by a parent is not. 2.4.13 (Focus Appearance) is level AAA and not claimed.',
  );
  return { stops, reachedEnd, trapped };
}

/** 2.4.1: the first Tab lands on a skip link, and following it moves focus to the main region. */
export async function skipLinkCheck(page, { evidence, route, context }) {
  evidence.sample(['2.4.1'], 'keyboard', route);
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const element = document.activeElement;
    return {
      isLink: element?.tagName === 'A' && (element.getAttribute('href') ?? '').startsWith('#'),
      href: element?.getAttribute?.('href') ?? null,
    };
  });
  if (!first.isLink) {
    evidence.fact('skipLinkWalk', route, { firstStopIsSkipLink: false });
    return false;
  }
  await page.keyboard.press('Enter');
  const moved = await page.evaluate((href) => {
    const target = document.querySelector(href);
    return (
      Boolean(target) &&
      (document.activeElement === target || target.contains(document.activeElement))
    );
  }, first.href);
  evidence.fact('skipLinkWalk', route, { firstStopIsSkipLink: true, movesFocusToTarget: moved });
  if (!moved) {
    evidence.finding({
      criteria: ['2.4.1'],
      check: 'keyboard',
      rule: 'skip-link-does-not-move-focus',
      severity: 'serious',
      route,
      context,
      message: `The skip link ${first.href} is the first tab stop but does not move focus to its target`,
      targets: [first.href],
    });
  }
  return moved;
}

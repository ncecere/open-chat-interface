/**
 * The automated and measured checks (steps 1, 3 and 4 of the spec's Method), one function per
 * check. Each takes a loaded page and `{ evidence, route, context }`, collects what it needs
 * through checks/page-scripts.mjs, judges it with the pure modules in ../lib, and records
 * samples and findings. A check that cannot judge something says so (`count`, `limit`): it
 * never counts what it could not measure as a pass.
 */

import { evaluateAutocomplete } from '../lib/autocomplete.mjs';
import {
  contrastRatio,
  effectiveBackground,
  evaluateNonTextContrast,
  evaluateTextContrast,
  isLargeText,
  parseColour,
  toHex,
} from '../lib/colour.mjs';
import { evaluateTargets } from '../lib/target-size.mjs';
import { findNewClipping, findNewOverlaps, TEXT_SPACING_CSS } from '../lib/text-spacing.mjs';
import { AXE_TAGS, criteriaFromAxeTags } from '../lib/wcag.mjs';
import {
  collectAnimations,
  collectContrastSamples,
  collectDocument,
  collectForms,
  collectMediaRules,
  collectNonTextSamples,
  collectReflow,
  collectTargets,
  collectTextRecords,
} from './page-scripts.mjs';

const themeGroup = (context) => `${context.theme}/${context.accent}`;

/** Waits until nothing finite is still animating: a theme transition mid-way shows blended colours. */
export async function settle(page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== 'running' ||
              animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
          ),
      undefined,
      { timeout: 4_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(150);
}

/** axe-core over the page with the WCAG 2.2 A and AA tag set. */
export async function axeCheck(page, { evidence, route, context, AxeBuilder }) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const applied = new Set();
  for (const group of [results.passes, results.violations]) {
    for (const rule of group) for (const id of criteriaFromAxeTags(rule.tags)) applied.add(id);
  }
  evidence.sample([...applied], 'axe', route);
  for (const violation of results.violations) {
    const criteria = criteriaFromAxeTags(violation.tags);
    if (criteria.length === 0) {
      evidence.count('axe', 'violations-without-a-criterion', 1);
      continue;
    }
    evidence.finding({
      criteria,
      check: 'axe',
      rule: violation.id,
      severity: violation.impact ?? 'moderate',
      route,
      context,
      message: violation.help,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    });
  }
  for (const rule of results.incomplete) {
    evidence.count('axe', `needs-review:${rule.id}`, rule.nodes.length);
  }
  evidence.limit(
    'axe',
    'axe-core finds a part of what WCAG asks (roughly a third of the criteria, and not whether alternative text or an error message is any good). A page with no violations is not a conformant page.',
  );
}

/** 1.4.3: every text colour pair, as rendered, over the colour it sits on. */
export async function contrastCheck(page, { evidence, route, context }) {
  const found = await page.evaluate(collectContrastSamples);
  evidence.sample(['1.4.3'], 'contrast', route);
  evidence.count('contrast', 'elements', found.total);
  evidence.count('contrast', 'not-judged-background-image', found.indeterminate);
  for (const sample of found.samples) {
    const fg = parseColour(sample.fg);
    const background = effectiveBackground(sample.layers);
    if (!fg || !background.determinate) {
      evidence.count('contrast', fg ? 'not-judged-background' : 'not-judged-colour', sample.count);
      continue;
    }
    const shown = { ...fg, a: fg.a * sample.opacity };
    const verdict = evaluateTextContrast({
      fg: shown,
      bg: background.colour,
      fontSizePx: sample.fontSizePx,
      fontWeight: sample.fontWeight,
    });
    const record = {
      kind: sample.kind,
      fg: toHex(fg),
      bg: toHex(background.colour),
      required: verdict.required,
      ratio: Math.round(verdict.ratio * 100) / 100,
      pass: verdict.pass,
      count: sample.count,
    };
    evidence.pair(themeGroup(context), route, record);
    if (!verdict.pass) {
      const large = isLargeText(sample.fontSizePx, sample.fontWeight) ? ', large text' : '';
      evidence.finding({
        criteria: ['1.4.3'],
        check: 'contrast',
        rule: sample.kind === 'placeholder' ? 'placeholder-contrast' : 'text-contrast',
        severity: 'serious',
        route,
        context,
        message: `${sample.kind === 'placeholder' ? 'Placeholder' : 'Text'} ${record.fg} on ${record.bg} is ${record.ratio}:1, needs ${verdict.required}:1 (${Math.round(sample.fontSizePx)}px${large})`,
        targets: sample.targets,
        detail: { fg: record.fg, bg: record.bg, ratio: record.ratio, elements: sample.count },
      });
    }
  }
  evidence.limit(
    'contrast',
    'The background is taken from the element and its ancestors, not from what is painted behind it: text over an image or gradient is counted as not judged, and a translucent overlay on another part of the page is not seen. Hover, active and disabled states are not measured (disabled controls are exempt).',
  );
}

/** 1.4.11: the edge of a field, and the glyph of an icon-only control. */
export async function nonTextContrastCheck(page, { evidence, route, context }) {
  const samples = await page.evaluate(collectNonTextSamples);
  evidence.sample(['1.4.11'], 'non-text-contrast', route);
  for (const sample of samples) {
    const surrounding = effectiveBackground(sample.surrounding ?? sample.layers);
    if (!surrounding.determinate) {
      evidence.count('non-text-contrast', 'not-judged-background', 1);
      continue;
    }
    if (sample.kind === 'icon') {
      const glyph = parseColour(sample.glyph);
      if (!glyph) continue;
      const verdict = evaluateNonTextContrast({ fg: glyph, bg: surrounding.colour });
      evidence.count('non-text-contrast', 'icons', 1);
      if (!verdict.pass) {
        evidence.finding({
          criteria: ['1.4.11'],
          check: 'non-text-contrast',
          rule: 'icon-contrast',
          severity: 'serious',
          route,
          context,
          message: `Icon ${toHex(glyph)} on ${toHex(surrounding.colour)} is ${verdict.ratio.toFixed(2)}:1, needs 3:1`,
          targets: [sample.target],
        });
      }
      continue;
    }
    // A field is identified by its border, its fill, or a ring: the best of them counts.
    const ratios = [];
    for (const border of sample.borderColours) {
      const colour = parseColour(border);
      if (colour && colour.a > 0)
        ratios.push(evaluateNonTextContrast({ fg: colour, bg: surrounding.colour }).ratio);
    }
    const fill = sample.fill ? parseColour(sample.fill) : null;
    if (fill && fill.a > 0) {
      const shown = effectiveBackground([sample.fill, ...(sample.surrounding ?? [])]).colour;
      ratios.push(contrastRatio(shown, surrounding.colour));
    }
    evidence.count('non-text-contrast', 'field-boundaries', 1);
    const best = ratios.length ? Math.max(...ratios) : 1;
    if (best < 3) {
      evidence.finding({
        criteria: ['1.4.11'],
        check: 'non-text-contrast',
        rule: 'field-boundary-contrast',
        severity: 'moderate',
        route,
        context,
        message: `The edge of ${sample.role} is ${best.toFixed(2)}:1 against its surroundings (border and fill), needs 3:1 where the edge is what identifies the field`,
        targets: [sample.target],
      });
    }
  }
  evidence.limit(
    'non-text-contrast',
    'Only the edges of fields and the glyphs of icon-only controls are measured (a field with no edge of its own is measured by the frame that draws it, when the page marks one with data-field-frame; a button-shaped combobox that shows its value as text is not measured as a field). Charts, status dots, custom graphics and the focus indicator (measured in the keyboard walkthroughs) are not part of this check. A field with a low-contrast edge is reported even where a label or placeholder also identifies it: that reading of 1.4.11 is the stricter one.',
  );
}

/** 2.5.8: every pointer target, at least 24 by 24 CSS px or an exception. */
export async function targetSizeCheck(page, { evidence, route, context }) {
  const targets = await page.evaluate(collectTargets);
  evidence.sample(['2.5.8'], 'target-size', route);
  evidence.count('target-size', 'targets', targets.length);
  const names = new Map(targets.map((target) => [target.id, target.target]));
  const { results, failures } = evaluateTargets(targets);
  for (const result of results) {
    if (result.exception && result.exception !== 'size') {
      evidence.count('target-size', `exception-${result.exception}`, 1);
    }
  }
  const grouped = new Map();
  for (const failure of failures) {
    const path = names.get(failure.id);
    const entry = grouped.get(path) ?? {
      count: 0,
      reason: failure.reason,
      size: `${Math.round(failure.width)}x${Math.round(failure.height)}`,
    };
    entry.count += 1;
    grouped.set(path, entry);
  }
  for (const [path, entry] of grouped) {
    evidence.finding({
      criteria: ['2.5.8'],
      check: 'target-size',
      rule: 'target-size',
      severity: 'moderate',
      route,
      context,
      message: `Target ${entry.size} px, under 24 by 24 and ${entry.reason.replace(/^\d+x\d+ px and /, '')}`,
      targets: [path],
      detail: { count: entry.count },
    });
  }
  evidence.limit(
    'target-size',
    'Decided by geometry: size, the 24 px spacing circle, inline links and native checkboxes. The exceptions that need judgement (an equivalent control elsewhere, essential size) are not applied, so a failure may carry one of them.',
  );
}

async function measureText(page) {
  return page.evaluate(collectTextRecords);
}

/** Runs `change`, measures what it moved, and puts the page back. Shared by 1.4.12 and 1.4.4. */
async function measureChange(
  page,
  { evidence, route, context, check, criterion, rule, css, what },
) {
  const before = await measureText(page);
  const style = await page.addStyleTag({ content: css });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const after = await measureText(page);
  const sideways = await page.evaluate(collectReflow);
  await style.evaluate((element) => element.remove());
  evidence.sample([criterion], check, route);
  if (before.truncated || after.truncated) evidence.count(check, 'truncated-text-list', 1);
  const names = new Map([...after.clips, ...after.texts].map((entry) => [entry.id, entry.path]));
  for (const clip of findNewClipping(before.clips, after.clips)) {
    evidence.finding({
      criteria: [criterion],
      check,
      rule: `${rule}-clipping`,
      // Text that was already truncated (an ellipsis on a long name) and loses more is a lesser
      // fault than text that fitted and no longer does.
      severity: clip.wasClipped ? 'review' : clip.ellipsis ? 'moderate' : 'serious',
      route,
      context,
      message: `With ${what}, ${clip.hiddenPx} px of content is cut off on the ${clip.axis} axis${clip.wasClipped ? ' (it was already truncated: check the full text is available another way)' : clip.ellipsis ? ' (shown with an ellipsis: check the full text is available another way)' : ''}`,
      targets: [names.get(clip.id) ?? clip.id],
    });
  }
  for (const overlap of findNewOverlaps(before.texts, after.texts)) {
    evidence.finding({
      criteria: [criterion],
      check,
      rule: `${rule}-overlap`,
      severity: 'serious',
      route,
      context,
      message: `With ${what}, two pieces of text overlap (${overlap.area} px2)`,
      targets: [
        names.get(overlap.first) ?? overlap.first,
        names.get(overlap.second) ?? overlap.second,
      ],
    });
  }
  if (sideways.offenders.length > 0 && check === 'text-resize') {
    evidence.finding({
      criteria: [criterion],
      check,
      rule: `${rule}-sideways`,
      severity: 'moderate',
      route,
      context,
      message: `With ${what}, content extends past the edge of the window`,
      targets: sideways.offenders.map((offender) => offender.path),
    });
  }
  evidence.limit(
    check,
    'Compares the page before and after: clipped text where a box hides its overflow, and text boxes that start to overlap. Text over images, text in canvases and iframes (the HTML artifact sandbox) is not seen.',
  );
}

/** 1.4.12: the WCAG text-spacing override. */
export async function textSpacingCheck(page, env) {
  await measureChange(page, {
    ...env,
    check: 'text-spacing',
    criterion: '1.4.12',
    rule: 'text-spacing',
    css: TEXT_SPACING_CSS,
    what: 'the 1.4.12 text spacing applied',
  });
}

/**
 * 1.4.4: text at 200%. The root font size is doubled, which scales everything sized in rem
 * as a browser's own "text size" preference would; sizes in px do not scale, which is itself
 * what a person who needs larger text would meet.
 */
export async function textResizeCheck(page, env) {
  await measureChange(page, {
    ...env,
    check: 'text-resize',
    criterion: '1.4.4',
    rule: 'text-resize',
    css: 'html { font-size: 200% !important; }',
    what: 'text at 200%',
  });
}

/** 1.4.10: no sideways scrolling at 320 CSS px wide (or 400% zoom of a 1280 px window). */
export async function reflowCheck(page, { evidence, route, context }) {
  const reflow = await page.evaluate(collectReflow);
  evidence.sample(['1.4.10'], 'reflow', route);
  if (
    reflow.scrollsSideways &&
    reflow.overflowX !== 'hidden' &&
    reflow.bodyOverflowX !== 'hidden'
  ) {
    evidence.finding({
      criteria: ['1.4.10'],
      check: 'reflow',
      rule: 'two-dimensional-scroll',
      severity: 'serious',
      route,
      context,
      message: `The page scrolls sideways at ${reflow.viewportWidth} px (content is ${reflow.scrollWidth} px wide)`,
      targets: reflow.offenders.map((offender) => offender.path),
    });
  } else if (reflow.offenders.length > 0) {
    evidence.finding({
      criteria: ['1.4.10'],
      check: 'reflow',
      rule: 'content-beyond-the-edge',
      severity: 'serious',
      route,
      context,
      message: `Content extends past the ${reflow.viewportWidth} px window and is clipped or unreachable`,
      targets: reflow.offenders.map((offender) => offender.path),
    });
  }
  evidence.limit(
    'reflow',
    "400% zoom is emulated as a 320 by 256 px window at a device scale of 4, not by driving the browser's zoom control. Content that needs two-dimensional layout (a wide table or code block inside a box that scrolls itself) is not counted, which is the exception WCAG allows.",
  );
}

const LOADING = /spin|pulse|loader|loading|skeleton|progress/i;

/** Long or endless animations, and whether the reduced-motion preference stops them. */
export async function motionCheck(page, { evidence, route, context, reduced }) {
  await page.waitForTimeout(400);
  const animations = await page.evaluate(collectAnimations);
  const rules = await page.evaluate(collectMediaRules);
  evidence.sample(['2.2.2'], 'motion', route);
  evidence.count(
    'motion',
    reduced ? 'running-with-reduced-motion' : 'running-without-preference',
    animations.length,
  );
  const long = animations.filter(
    (animation) => animation.iterations === 'infinite' || (animation.durationMs ?? 0) > 5000,
  );
  for (const animation of long) {
    const loading = LOADING.test(`${animation.name} ${animation.target}`);
    if (reduced) {
      evidence.finding({
        criteria: ['2.2.2'],
        check: 'motion',
        rule: 'animation-ignores-reduced-motion',
        severity: loading ? 'review' : 'moderate',
        route,
        context,
        message: `${animation.kind} "${animation.name}" runs ${animation.iterations === 'infinite' ? 'forever' : `${animation.durationMs} ms`} although the person asked for reduced motion${loading ? ' (a loading indicator: review whether it is essential)' : ''}`,
        targets: [animation.target],
      });
    } else if (!loading) {
      evidence.finding({
        criteria: ['2.2.2'],
        check: 'motion',
        rule: 'auto-starting-motion',
        severity: 'review',
        route,
        context,
        message: `${animation.kind} "${animation.name}" starts by itself and runs ${animation.iterations === 'infinite' ? 'forever' : `${animation.durationMs} ms`}: check it can be paused`,
        targets: [animation.target],
      });
    }
  }
  evidence.fact('motion', `${route}:${reduced ? 'reduce' : 'default'}`, {
    running: animations.length,
    reducedMotionRules: rules.reducedMotionRules,
    unreadableSheets: rules.unreadableSheets,
  });
  evidence.limit(
    'motion',
    'Animations running a moment after the page settles. Motion that starts on an action (a reply streaming, a panel opening) is not seen here. 2.3.3 is level AAA and not claimed.',
  );
}

const WITHOUT_PASTE = /password|code|otp/i;

/** Labels, error wiring, autocomplete tokens and paste, from the page's own fields. */
export async function formsCheck(page, { evidence, route, context, ownDetails }) {
  const forms = await page.evaluate(collectForms);
  // Whether each field has a name is read from the accessibility tree (checks/tree.mjs), which
  // sees through the hidden inputs that component libraries put beside a styled control.
  for (const field of forms.invalid) {
    evidence.sample(['3.3.1'], 'forms', route);
    if (!field.hasAssociatedMessage) {
      evidence.finding({
        criteria: ['3.3.1'],
        check: 'forms',
        rule: 'invalid-field-without-message',
        severity: 'serious',
        route,
        context,
        message: 'A field marked invalid has no error text associated with it',
        targets: [field.target],
      });
    }
  }
  if (ownDetails) {
    evidence.sample(['1.3.5'], 'forms', route);
    const checked = evaluateAutocomplete(
      forms.fields.map((field, index) => ({ id: String(index), ...field })),
    );
    for (const problem of checked) {
      const field = forms.fields[Number(problem.id)];
      evidence.finding({
        criteria: ['1.3.5'],
        check: 'forms',
        rule: `autocomplete-${problem.problem}`,
        severity: 'moderate',
        route,
        context,
        message: `A ${field.type} field (${field.label || 'no label'}) has autocomplete "${problem.actual}", expected one of ${problem.expected.join(', ')}`,
        targets: [field.target],
      });
    }
  }
  const pasteFields = forms.fields.filter(
    (field) => field.type === 'password' || WITHOUT_PASTE.test(field.label),
  );
  if (pasteFields.length > 0) {
    evidence.sample(['3.3.8'], 'forms', route);
    const blocked = await page.evaluate(() => {
      const refused = [];
      const fields = document.querySelectorAll(
        'input[type="password"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
      );
      for (const field of fields) {
        const data = new DataTransfer();
        data.setData('text/plain', '123456');
        const event = new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        });
        field.dispatchEvent(event);
        if (event.defaultPrevented)
          refused.push(field.tagName.toLowerCase() + (field.type ? `[type=${field.type}]` : ''));
      }
      return refused;
    });
    for (const target of blocked) {
      evidence.finding({
        criteria: ['3.3.8'],
        check: 'forms',
        rule: 'paste-blocked',
        severity: 'serious',
        route,
        context,
        message: 'Pasting into a password or code field is refused',
        targets: [target],
      });
    }
  }
  return forms;
}

/** Title, language, landmarks and headings of the page as a whole. */
export async function documentCheck(page, { evidence, route, context, expectedLanguage }) {
  const doc = await page.evaluate(collectDocument);
  evidence.sample(['2.4.2', '3.1.1'], 'document', route);
  evidence.fact('titles', route, doc.title);
  if (doc.title.trim() === '') {
    evidence.finding({
      criteria: ['2.4.2'],
      check: 'document',
      rule: 'page-without-title',
      severity: 'serious',
      route,
      context,
      message: 'The page has no title',
    });
  }
  if (!doc.lang) {
    evidence.finding({
      criteria: ['3.1.1'],
      check: 'document',
      rule: 'page-without-language',
      severity: 'serious',
      route,
      context,
      message: 'The page does not declare its language',
    });
  } else if (expectedLanguage && doc.lang.toLowerCase() !== expectedLanguage.toLowerCase()) {
    evidence.finding({
      criteria: ['3.1.1'],
      check: 'document',
      rule: 'language-mismatch',
      severity: 'moderate',
      route,
      context,
      message: `The page declares "${doc.lang}" but is showing "${expectedLanguage}"`,
    });
  }
  const rtl = /^ar/i.test(expectedLanguage ?? '');
  if (expectedLanguage && (doc.dir === 'rtl') !== rtl) {
    evidence.finding({
      criteria: ['1.3.2'],
      check: 'document',
      rule: 'direction-mismatch',
      severity: 'serious',
      route,
      context,
      message: `The page direction is "${doc.dir || 'unset'}" for a ${rtl ? 'right-to-left' : 'left-to-right'} language`,
    });
  }
  evidence.sample(['1.3.1', '2.4.1'], 'document', route);
  const mains = doc.landmarks.main.length;
  if (mains !== 1) {
    evidence.finding({
      criteria: ['1.3.1', '2.4.1'],
      check: 'document',
      rule: mains === 0 ? 'no-main-landmark' : 'several-main-landmarks',
      severity: mains === 0 ? 'serious' : 'moderate',
      route,
      context,
      message: `The page has ${mains} main landmarks, expected 1`,
    });
  }
  for (const role of ['navigation', 'complementary', 'banner', 'contentinfo']) {
    const entries = doc.landmarks[role];
    if (entries.length > 1 && entries.some((entry) => entry.label === '')) {
      evidence.finding({
        criteria: ['1.3.1'],
        check: 'document',
        rule: 'unlabelled-repeated-landmark',
        severity: 'review',
        route,
        context,
        message: `${entries.length} ${role} landmarks and at least one has no label`,
      });
    }
  }
  const levels = doc.headings.map((heading) => heading.level);
  evidence.sample(['2.4.6'], 'document', route);
  if (!levels.includes(1)) {
    evidence.finding({
      criteria: ['2.4.6'],
      check: 'document',
      rule: 'no-level-one-heading',
      severity: 'review',
      route,
      context,
      message: 'The page has no level 1 heading',
    });
  }
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) {
      evidence.finding({
        criteria: ['2.4.6'],
        check: 'document',
        rule: 'heading-level-skipped',
        severity: 'review',
        route,
        context,
        message: `A heading jumps from level ${levels[i - 1]} to ${levels[i]}`,
      });
      break;
    }
  }
  const viewport = doc.viewportMeta ?? '';
  evidence.sample(['1.4.4'], 'document', route);
  if (
    /user-scalable\s*=\s*(no|0)/i.test(viewport) ||
    /maximum-scale\s*=\s*(0?\.\d+|1(\.0+)?)\b/i.test(viewport)
  ) {
    evidence.finding({
      criteria: ['1.4.4'],
      check: 'document',
      rule: 'zoom-disabled',
      severity: 'critical',
      route,
      context,
      message: `The viewport meta tag stops people zooming: "${viewport}"`,
    });
  }
  evidence.fact(
    'landmarks',
    route,
    Object.fromEntries(Object.entries(doc.landmarks).map(([role, list]) => [role, list.length])),
  );
  evidence.fact('skipLinks', route, doc.skipLink);
  return doc;
}

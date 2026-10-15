import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compositeOver,
  contrastRatio,
  effectiveBackground,
  evaluateTextContrast,
  isLargeText,
  parseColour,
  relativeLuminance,
  toHex,
} from './a11y-audit/lib/colour.mjs';

const near = (actual, expected, tolerance = 0.01) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not within ${tolerance} of ${expected}`,
  );

test('black on white is 21:1 and white on white is 1:1', () => {
  const black = parseColour('rgb(0, 0, 0)');
  const white = parseColour('rgb(255, 255, 255)');
  near(contrastRatio(black, white), 21, 0.001);
  near(contrastRatio(white, white), 1, 0.001);
  // Order does not matter.
  near(contrastRatio(white, black), 21, 0.001);
});

test('known pairs from the WCAG definitions', () => {
  // #767676 on white is the lightest grey that reaches 4.5:1 (4.54).
  near(contrastRatio(parseColour('#767676'), parseColour('#fff')), 4.54, 0.01);
  // #777777 on white just misses it (4.48).
  near(contrastRatio(parseColour('#777'), parseColour('#ffffff')), 4.48, 0.01);
  // The classic WebAIM example: #595959 on white is 7:1.
  near(contrastRatio(parseColour('#595959'), parseColour('#fff')), 7.0, 0.01);
  // Mid grey on black.
  near(contrastRatio(parseColour('rgb(128 128 128)'), parseColour('rgb(0 0 0)')), 5.32, 0.01);
});

test('relative luminance uses the sRGB transfer curve', () => {
  near(relativeLuminance(parseColour('#000')), 0, 1e-9);
  near(relativeLuminance(parseColour('#fff')), 1, 1e-9);
  near(relativeLuminance(parseColour('#ff0000')), 0.2126, 1e-4);
  near(relativeLuminance(parseColour('#00ff00')), 0.7152, 1e-4);
  near(relativeLuminance(parseColour('#0000ff')), 0.0722, 1e-4);
});

test('parses the notations a computed style can take', () => {
  assert.deepEqual(toHex(parseColour('rgb(18, 52, 86)')), '#123456');
  assert.deepEqual(toHex(parseColour('rgba(18 52 86 / 0.5)')), '#123456');
  assert.equal(parseColour('rgba(18, 52, 86, 0.5)').a, 0.5);
  assert.equal(parseColour('rgb(18 52 86 / 50%)').a, 0.5);
  assert.equal(toHex(parseColour('#abc')), '#aabbcc');
  assert.equal(parseColour('#11223380').a.toFixed(2), '0.50');
  assert.equal(parseColour('transparent').a, 0);
  assert.equal(toHex(parseColour('color(srgb 1 0.5 0)')), '#ff8000');
  assert.equal(parseColour('color(srgb 1 0 0 / 0.25)').a, 0.25);
  assert.equal(parseColour('not a colour'), null);
  assert.equal(parseColour(''), null);
  assert.equal(parseColour(undefined), null);
});

test('parses oklch and oklab the way a modern browser reports them', () => {
  // The reference values are CSS Color 4's: oklch(0.5 0 0) is a neutral grey.
  assert.equal(toHex(parseColour('oklch(100% 0 0)')), '#ffffff');
  assert.equal(toHex(parseColour('oklch(0% 0 0)')), '#000000');
  // oklch(62.8% 0.2577 29.23) is sRGB red to within rounding.
  assert.equal(toHex(parseColour('oklch(0.628 0.2577 29.23)')), '#ff0000');
  assert.equal(toHex(parseColour('oklab(0.628 0.2249 0.1258)')), '#ff0000');
  // A mid neutral: oklch(0.5 0 0) is about #636363.
  assert.equal(toHex(parseColour('oklch(50% 0 0)')), '#636363');
  assert.equal(parseColour('oklch(50% 0 0 / 0.4)').a, 0.4);
  // "none" components are zero.
  assert.equal(toHex(parseColour('oklch(100% none none)')), '#ffffff');
});

test('compositing a translucent colour over an opaque one', () => {
  const over = compositeOver(parseColour('rgb(255 0 0 / 0.5)'), parseColour('#ffffff'));
  assert.equal(toHex(over), '#ff8080');
  assert.equal(over.a, 1);
  // Opaque ignores the backdrop; fully transparent shows it.
  assert.equal(toHex(compositeOver(parseColour('#102030'), parseColour('#fff'))), '#102030');
  assert.equal(toHex(compositeOver(parseColour('transparent'), parseColour('#fff'))), '#ffffff');
});

test('the effective background is built up through the ancestors, nearest first', () => {
  // A 50% black panel over a white page is mid grey.
  const stack = ['rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)'];
  const result = effectiveBackground(stack);
  assert.equal(result.determinate, true);
  assert.equal(toHex(result.colour), '#808080');
  // Opaque near the element: nothing behind it matters.
  assert.equal(
    toHex(effectiveBackground(['rgb(10, 20, 30)', 'rgb(255 255 255)']).colour),
    '#0a141e',
  );
  // Nothing opaque anywhere: the canvas is white.
  assert.equal(toHex(effectiveBackground(['rgba(0,0,0,0)']).colour), '#ffffff');
  // A background image or gradient anywhere in the chain makes the answer unknown.
  assert.equal(
    effectiveBackground(['rgba(0,0,0,0)', { image: true }, 'rgb(0 0 0)']).determinate,
    false,
  );
  // Unparseable input is unknown, never guessed.
  assert.equal(effectiveBackground(['wat']).determinate, false);
});

test('large text is 24px, or 18.66px and bold', () => {
  assert.equal(isLargeText(24, 400), true);
  assert.equal(isLargeText(23.9, 400), false);
  assert.equal(isLargeText(18.66, 700), true);
  assert.equal(isLargeText(18.5, 700), false);
  assert.equal(isLargeText(18.66, 600), false);
  assert.equal(isLargeText(14, 700), false);
});

test('text contrast thresholds: 4.5:1, and 3:1 for large text', () => {
  const white = parseColour('#fff');
  const small = evaluateTextContrast({
    fg: parseColour('#777'),
    bg: white,
    fontSizePx: 16,
    fontWeight: 400,
  });
  assert.equal(small.pass, false);
  assert.equal(small.required, 4.5);
  near(small.ratio, 4.48, 0.01);

  const large = evaluateTextContrast({
    fg: parseColour('#777'),
    bg: white,
    fontSizePx: 24,
    fontWeight: 400,
  });
  assert.equal(large.pass, true);
  assert.equal(large.required, 3);

  const exactly = evaluateTextContrast({
    fg: parseColour('#767676'),
    bg: white,
    fontSizePx: 16,
    fontWeight: 400,
  });
  assert.equal(exactly.pass, true);
});

test('translucent text is composited over its background before it is judged', () => {
  // Black at 40% on white is a light grey (#999999): about 2.85:1, a failure.
  const result = evaluateTextContrast({
    fg: parseColour('rgb(0 0 0 / 0.4)'),
    bg: parseColour('#fff'),
    fontSizePx: 16,
    fontWeight: 400,
  });
  near(result.ratio, 2.85, 0.02);
  assert.equal(result.pass, false);
});

test('a ratio is not rounded up to pass: 4.499 fails', () => {
  // #767676 is 4.54; a colour a hair darker than the 4.5 boundary would pass and one a hair
  // lighter must not be rounded to it. #777777 is 4.478 and is shown as 4.48, still a failure.
  const result = evaluateTextContrast({
    fg: parseColour('#777777'),
    bg: parseColour('#ffffff'),
    fontSizePx: 14,
    fontWeight: 400,
  });
  assert.equal(result.pass, false);
});

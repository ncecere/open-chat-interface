/**
 * Colour arithmetic for WCAG 1.4.3 (text contrast) and 1.4.11 (non-text contrast).
 *
 * Pure: strings and numbers in, numbers out, no browser. The in-page collector
 * (checks/page-scripts.mjs) hands over the computed-style strings it finds and this module
 * does the sums, so every threshold is covered by a unit test on known colours.
 *
 * A colour is `{ r, g, b, a }` with r, g, b in 0..1 (sRGB, gamma-encoded) and a in 0..1.
 */

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** @param {string} token a CSS number or percentage; `none` is zero */
function component(token, percentBase) {
  const text = String(token).trim();
  if (text === 'none') return 0;
  if (text.endsWith('%')) return (Number.parseFloat(text) / 100) * percentBase;
  const value = Number(text);
  return Number.isNaN(value) ? Number.NaN : value;
}

function alphaOf(token) {
  if (token === undefined) return 1;
  const value = component(token, 1);
  return Number.isNaN(value) ? Number.NaN : clamp01(value);
}

/** An angle in degrees: a bare number, or deg, rad, grad or turn. */
function hue(token) {
  const text = String(token).trim();
  if (text === 'none') return 0;
  const value = Number.parseFloat(text);
  if (Number.isNaN(value)) return Number.NaN;
  if (text.endsWith('grad')) return value * 0.9;
  if (text.endsWith('rad')) return (value * 180) / Math.PI;
  if (text.endsWith('turn')) return value * 360;
  return value;
}

const encode = (linear) => {
  const value = clamp01(linear);
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
};

/** OKLab to sRGB, from Björn Ottosson's reference (the matrices CSS Color 4 uses). */
function fromOklab(lightness, a, b, alpha) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

/** Splits `fn(a b c / d)` or `fn(a, b, c, d)` into its numeric tokens and an alpha token. */
function functionArguments(body, legacyAlpha = true) {
  const [colour, alpha] = body.split('/');
  const parts = colour
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
  // The comma form `rgba(r, g, b, a)` carries alpha as a fourth value; `color()` never does.
  if (legacyAlpha && alpha === undefined && parts.length === 4) {
    return { parts: parts.slice(0, 3), alpha: parts[3] };
  }
  return { parts, alpha: alpha?.trim() };
}

/**
 * Parses what `getComputedStyle` returns for a colour: `rgb()`, `rgba()`, `oklch()`, `oklab()`,
 * `color(srgb …)`, hex and `transparent`. Anything else is `null`, which the caller counts as
 * "could not be judged" and never guesses at.
 *
 * @param {string | null | undefined} css
 * @returns {{ r: number, g: number, b: number, a: number } | null}
 */
export function parseColour(css) {
  if (typeof css !== 'string') return null;
  const text = css.trim().toLowerCase();
  if (text === '') return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
    const channel = (index) => Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
    return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? channel(3) : 1 };
  }

  const fn = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (!fn) return null;
  const [, name, body] = fn;

  if (name === 'rgb' || name === 'rgba') {
    const { parts, alpha } = functionArguments(body);
    if (parts.length !== 3) return null;
    const [r, g, b] = parts.map((part) => component(part, 255) / 255);
    const a = alphaOf(alpha);
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
  }

  if (name === 'oklch' || name === 'oklab') {
    const { parts, alpha } = functionArguments(body);
    if (parts.length !== 3) return null;
    const lightness = component(parts[0], 1);
    const a = alphaOf(alpha);
    let first;
    let second;
    if (name === 'oklch') {
      const chroma = component(parts[1], 0.4);
      const angle = (hue(parts[2]) * Math.PI) / 180;
      first = chroma * Math.cos(angle);
      second = chroma * Math.sin(angle);
    } else {
      first = component(parts[1], 0.4);
      second = component(parts[2], 0.4);
    }
    if ([lightness, first, second, a].some(Number.isNaN)) return null;
    return fromOklab(lightness, first, second, a);
  }

  if (name === 'color') {
    const { parts, alpha } = functionArguments(body, false);
    if (parts[0] !== 'srgb' || parts.length !== 4) return null;
    const [r, g, b] = parts.slice(1).map((part) => component(part, 1));
    const a = alphaOf(alpha);
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
  }

  return null;
}

/** `#rrggbb`, ignoring alpha. */
export function toHex(colour) {
  const byte = (value) =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(colour.r)}${byte(colour.g)}${byte(colour.b)}`;
}

/** The colour `top` shows as when laid over `bottom` (the result is opaque if `bottom` is). */
export function compositeOver(top, bottom) {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function relativeLuminance(colour) {
  const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b);
}

/** WCAG contrast ratio, 1 to 21, unrounded. Both colours are taken as opaque. */
export function contrastRatio(first, second) {
  const one = relativeLuminance(first);
  const two = relativeLuminance(second);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

const WHITE = { r: 1, g: 1, b: 1, a: 1 };

/**
 * The colour a surface really shows, from the `background-color` of an element and each
 * ancestor, nearest first. A layer is a CSS colour string, or `{ image: true }` for a
 * background image or gradient, whose colour is not known. The page canvas is white.
 *
 * `determinate: false` means an image sits where it could matter, or a colour could not be
 * parsed: the caller reports the sample as not judged rather than guessing.
 *
 * @param {(string | { image: true })[]} layers
 */
export function effectiveBackground(layers) {
  let accumulated = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of layers) {
    if (accumulated.a >= 0.999) break;
    if (typeof layer !== 'string') return { colour: WHITE, determinate: false };
    const parsed = parseColour(layer);
    if (!parsed) return { colour: WHITE, determinate: false };
    accumulated = compositeOver(accumulated, parsed);
  }
  return { colour: compositeOver(accumulated, WHITE), determinate: true };
}

/** WCAG large text: 24 CSS px, or 18.66 CSS px (14pt) and bold. */
export function isLargeText(fontSizePx, fontWeight) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && Number(fontWeight) >= 700);
}

/**
 * Judges text against 1.4.3. `fg` may be translucent: it is laid over `bg` first. The ratio is
 * not rounded, so 4.499 fails.
 */
export function evaluateTextContrast({ fg, bg, fontSizePx, fontWeight }) {
  const shown = fg.a < 1 ? compositeOver(fg, bg) : fg;
  const ratio = contrastRatio(shown, bg);
  const required = isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
  return { ratio, required, pass: ratio >= required };
}

/** 1.4.11: user interface components and graphics need 3:1 against what is next to them. */
export function evaluateNonTextContrast({ fg, bg }) {
  const shown = fg.a < 1 ? compositeOver(fg, bg) : fg;
  const ratio = contrastRatio(shown, bg);
  return { ratio, required: 3, pass: ratio >= 3 };
}

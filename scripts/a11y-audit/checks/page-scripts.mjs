/**
 * Functions that run INSIDE the page (`page.evaluate`). Each is self-contained: it may not use
 * anything from this module or from Node, because Playwright serialises its source.
 *
 * They only collect. Every judgement (is this ratio enough, is this box big enough) is made in
 * Node by the pure modules in ../lib, which have unit tests. What leaves the page is
 * computed-style strings, boxes and counts, never page text.
 */

/** Text samples: every element that directly holds visible text, with its colours and size. */
export function collectContrastSamples() {
  const MAX_UNIQUE = 4000;

  const cssPath = (element) => {
    const parts = [];
    for (
      let node = element;
      node && node.nodeType === 1 && parts.length < 3;
      node = node.parentElement
    ) {
      if (node === document.body || node === document.documentElement) break;
      let part = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}|:/.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const classes = [...node.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };

  const isOpaque = (colour) =>
    /^rgb\(/.test(colour) || (/^(oklch|oklab|color)\(/.test(colour) && !colour.includes('/'));
  const isClear = (colour) =>
    /^rgba\(.*,\s*0\)$/.test(colour) ||
    /\/\s*0(\.0+)?\s*\)$/.test(colour) ||
    colour === 'transparent';

  const layerCache = new Map();
  const layersFor = (element) => {
    if (!element) return [];
    if (layerCache.has(element)) return layerCache.get(element);
    const style = getComputedStyle(element);
    let layers = [];
    const own = style.backgroundColor;
    if (style.backgroundImage !== 'none') layers.push({ image: true });
    if (!isClear(own)) layers.push(own);
    if (!(isOpaque(own) && !layers.some((layer) => typeof layer !== 'string'))) {
      layers = layers.concat(layersFor(element.parentElement));
    }
    layerCache.set(element, layers);
    return layers;
  };

  const opacityOf = (element) => {
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(node).opacity);
    }
    return opacity;
  };

  const visible = (element) => {
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }))
        return false;
    }
    const rect = element.getBoundingClientRect();
    // Visually hidden text (the skip link until focused, screen-reader-only labels).
    if (rect.width <= 1 || rect.height <= 1) return false;
    return true;
  };

  const disabled = (element) =>
    Boolean(element.closest(':disabled, [aria-disabled="true"], [inert]'));

  const unique = new Map();
  let skippedImage = 0;
  let total = 0;

  const record = (element, kind, foreground, fontSize, fontWeight) => {
    total += 1;
    const layers = layersFor(element);
    if (layers.some((layer) => typeof layer !== 'string')) skippedImage += 1;
    const opacity = opacityOf(element);
    const signature = JSON.stringify([kind, foreground, layers, opacity, fontSize, fontWeight]);
    let entry = unique.get(signature);
    if (!entry) {
      if (unique.size >= MAX_UNIQUE) return;
      entry = {
        kind,
        fg: foreground,
        layers,
        opacity,
        fontSizePx: fontSize,
        fontWeight,
        count: 0,
        targets: [],
      };
      unique.set(signature, entry);
    }
    entry.count += 1;
    if (entry.targets.length < 3) entry.targets.push(cssPath(element));
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/\S/.test(node.nodeValue)) continue;
    const element = node.parentElement;
    if (!element || seen.has(element)) continue;
    seen.add(element);
    if (element.closest('script, style, noscript, template, svg, [hidden]')) continue;
    if (!visible(element) || disabled(element)) continue;
    const style = getComputedStyle(element);
    record(
      element,
      'text',
      style.color,
      Number.parseFloat(style.fontSize),
      Number(style.fontWeight),
    );
  }

  for (const field of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (field.value || !visible(field) || disabled(field)) continue;
    const style = getComputedStyle(field);
    const placeholder = getComputedStyle(field, '::placeholder');
    record(
      field,
      'placeholder',
      placeholder.color,
      Number.parseFloat(style.fontSize),
      Number(style.fontWeight),
    );
  }

  return { total, indeterminate: skippedImage, samples: [...unique.values()] };
}

/**
 * Non-text samples for 1.4.11: the boundary of form fields and the glyph of icon-only controls.
 * Each carries the colours and the layers behind it; Node does the contrast.
 */
export function collectNonTextSamples() {
  const cssPath = (element) => {
    const parts = [];
    for (
      let node = element;
      node && node.nodeType === 1 && parts.length < 3;
      node = node.parentElement
    ) {
      if (node === document.body || node === document.documentElement) break;
      let part = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}|:/.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const classes = [...node.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const isOpaque = (colour) =>
    /^rgb\(/.test(colour) || (/^(oklch|oklab|color)\(/.test(colour) && !colour.includes('/'));
  const isClear = (colour) =>
    /^rgba\(.*,\s*0\)$/.test(colour) ||
    /\/\s*0(\.0+)?\s*\)$/.test(colour) ||
    colour === 'transparent';
  const layersFrom = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') {
        layers.push({ image: true });
        continue;
      }
      if (isClear(style.backgroundColor)) continue;
      layers.push(style.backgroundColor);
      if (isOpaque(style.backgroundColor)) break;
    }
    return layers;
  };
  const visible = (element) => {
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ visibilityProperty: true })
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };
  const disabled = (element) =>
    Boolean(element.closest(':disabled, [aria-disabled="true"], [inert]'));

  const samples = [];

  // Field boundaries. A native checkbox or radio is drawn by the browser and is exempt.
  const fields = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="submit"]):not([type="button"]), select, textarea, [role="combobox"], [role="textbox"], [role="switch"], [role="checkbox"], [role="radio"]',
  );
  for (const field of fields) {
    if (!visible(field) || disabled(field)) continue;
    const style = getComputedStyle(field);
    const borders = ['Top', 'Right', 'Bottom', 'Left']
      .map((side) => ({
        width: Number.parseFloat(style[`border${side}Width`]),
        style: style[`border${side}Style`],
        colour: style[`border${side}Color`],
      }))
      .filter((border) => border.width > 0 && border.style !== 'none');
    samples.push({
      kind: 'field-boundary',
      target: cssPath(field),
      role: field.getAttribute('role') ?? field.tagName.toLowerCase(),
      borderColours: [...new Set(borders.map((border) => border.colour))],
      fill: isClear(style.backgroundColor) ? null : style.backgroundColor,
      surrounding: layersFrom(field.parentElement),
      // A visible ring, a shadow or an outline also marks the edge.
      hasShadow: style.boxShadow !== 'none',
    });
  }

  // Icon-only controls: a button or link with no visible text whose only content is a graphic.
  const controls = document.querySelectorAll(
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="tab"]',
  );
  for (const control of controls) {
    if (!visible(control) || disabled(control)) continue;
    if (/\S/.test(control.textContent ?? '')) continue;
    const icon = control.querySelector('svg');
    if (!icon) continue;
    const style = getComputedStyle(icon);
    const stroke = style.stroke !== 'none' ? style.stroke : null;
    const fill = style.fill !== 'none' ? style.fill : null;
    const glyph = stroke ?? fill;
    if (!glyph) continue;
    samples.push({
      kind: 'icon',
      target: cssPath(control),
      glyph,
      layers: layersFrom(control),
    });
  }
  return samples;
}

/** Everything the user can point at or tap, with its box and the exceptions geometry cannot see. */
export function collectTargets() {
  const cssPath = (element) => {
    const parts = [];
    for (
      let node = element;
      node && node.nodeType === 1 && parts.length < 3;
      node = node.parentElement
    ) {
      if (node === document.body || node === document.documentElement) break;
      let part = node.tagName.toLowerCase();
      if (node.id && !/\d{3,}|:/.test(node.id)) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const classes = [...node.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="separator"][tabindex]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const targets = [];
  const elements = [...document.querySelectorAll(SELECTOR)];
  const ids = new Map();
  elements.forEach((element, index) => {
    ids.set(element, `t${index}`);
  });

  const nativeStyleUntouched = (element) => {
    const style = getComputedStyle(element);
    return (
      style.appearance === 'auto' || style.appearance === 'checkbox' || style.appearance === 'radio'
    );
  };

  for (const element of elements) {
    if (
      element.closest('[inert], [hidden]') ||
      element.matches(':disabled, [aria-disabled="true"]')
    )
      continue;
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const rect = element.getBoundingClientRect();
    // A visually hidden control (the skip link until focus, a native input behind a custom one).
    const style = getComputedStyle(element);
    if (rect.width <= 1 && rect.height <= 1) continue;
    if (style.opacity === '0' && !element.matches('input[type="checkbox"], input[type="radio"]'))
      continue;

    const containerIds = [];
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (ids.has(node)) containerIds.push(ids.get(node));
    }

    // Inline: a link inside a sentence or other running text.
    let inline = false;
    if (element.matches('a[href]') && style.display === 'inline') {
      const parent = element.parentElement;
      const around = (parent?.textContent ?? '').replace(element.textContent ?? '', '').trim();
      inline =
        around.length > 0 &&
        /^(p|li|span|em|strong|dd|dt|td|th|label|small|blockquote|div)$/i.test(parent.tagName);
    }
    const nativeControl =
      element.matches('input[type="checkbox"], input[type="radio"]') &&
      nativeStyleUntouched(element);

    targets.push({
      id: ids.get(element),
      target: cssPath(element),
      rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      inline,
      userAgent: nativeControl,
      containerIds,
    });
  }
  return targets;
}

/**
 * Marks every text-bearing element with a stable id and measures what the 1.4.12 and 1.4.4 checks
 * compare before and after a change: the line boxes of its text, clipped to what is visible (an
 * ancestor that hides its overflow, as a screen-reader-only or truncated element does, cuts the
 * box), and the boxes that hide their overflow.
 */
export function collectTextRecords() {
  const records = [];
  const clips = [];
  let index = 0;
  const pathOf = (element) =>
    [
      element.tagName.toLowerCase(),
      ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
    ].join('.');
  // The part of `rect` that is not cut off by an ancestor that clips; null when none is left.
  const visiblePart = (element, rect) => {
    let { left, top, right, bottom } = rect;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        left = Math.max(left, box.left + node.clientLeft);
        right = Math.min(right, box.left + node.clientLeft + node.clientWidth);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, box.top + node.clientTop);
        bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    return right - left > 0 && bottom - top > 0
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : null;
  };

  const elements = document.body.querySelectorAll('*');
  for (const element of elements) {
    if (element.closest('script, style, svg, noscript, template')) continue;
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    let id = element.getAttribute('data-a11y-audit-id');
    if (!id) {
      id = `e${index}`;
      element.setAttribute('data-a11y-audit-id', id);
    }
    index += 1;
    const style = getComputedStyle(element);
    const hasOwnText = [...element.childNodes].some(
      (child) => child.nodeType === 3 && /\S/.test(child.nodeValue),
    );
    if (hasOwnText && records.length < 3000) {
      const ancestorIds = [];
      for (let node = element.parentElement; node; node = node.parentElement) {
        const ancestorId = node.getAttribute('data-a11y-audit-id');
        if (ancestorId) ancestorIds.push(ancestorId);
      }
      // One box per line of the element's own text, not the union a wrapped inline element has.
      let line = 0;
      for (const child of element.childNodes) {
        if (child.nodeType !== 3 || !/\S/.test(child.nodeValue)) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        for (const box of range.getClientRects()) {
          if (box.width < 1 || box.height < 1) continue;
          const part = visiblePart(element, {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          });
          if (!part) continue;
          records.push({
            id: `${id}#${line}`,
            owner: id,
            rect: {
              x: part.x + scrollX,
              y: part.y + scrollY,
              width: part.width,
              height: part.height,
            },
            ancestorIds,
            path: pathOf(element),
          });
          line += 1;
        }
      }
    }
    // A field scrolls its own text, so a long value is not content lost.
    if (element.matches('input, textarea, select')) continue;
    if (/hidden|clip/.test(style.overflowX + style.overflowY)) {
      clips.push({
        id,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        textOverflow: style.textOverflow,
        path: pathOf(element),
      });
    }
  }
  return { texts: records, clips, truncated: records.length >= 3000 };
}

/**
 * 1.4.10: does the page scroll in two directions, and which elements poke out of the viewport
 * sideways without being inside a box that scrolls or clips them.
 */
export function collectReflow() {
  const root = document.documentElement;
  const viewportWidth = root.clientWidth;
  const rtl = getComputedStyle(root).direction === 'rtl';
  const scrollable = (value) => /auto|scroll/.test(value);
  const clipsToViewport = (value) => /hidden|clip/.test(value);

  const path = (element) =>
    [
      element.tagName.toLowerCase(),
      ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
    ].join('.');

  const offenders = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const beyond = rtl ? rect.left < -1 : rect.right > viewportWidth + 1;
    if (!beyond) continue;
    // Inside a box that scrolls itself, or whose own edge is inside the viewport and clips it.
    let contained = false;
    for (
      let node = element.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const edge = rtl ? box.left >= -1 : box.right <= viewportWidth + 1;
      if (scrollable(style.overflowX) || (clipsToViewport(style.overflowX) && edge)) {
        contained = true;
        break;
      }
      if (style.position === 'fixed') break;
    }
    if (contained) continue;
    // Report the outermost offender only: its children are beyond the edge because it is.
    const parent = element.parentElement;
    const parentBox = parent?.getBoundingClientRect();
    const parentBeyond =
      parentBox && (rtl ? parentBox.left < -1 : parentBox.right > viewportWidth + 1);
    if (parentBeyond && parent !== document.body) continue;
    offenders.push({
      path: path(element),
      right: Math.round(rect.right),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
    });
    if (offenders.length >= 10) break;
  }

  return {
    viewportWidth,
    scrollWidth: root.scrollWidth,
    scrollsSideways: root.scrollWidth > viewportWidth + 1,
    overflowX: getComputedStyle(root).overflowX,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
    offenders,
  };
}

/** Animations and transitions in progress: how long, how many times, and on what. */
export function collectAnimations() {
  const path = (element) =>
    element
      ? [
          element.tagName.toLowerCase(),
          ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
        ].join('.')
      : 'unknown';
  const running = document.getAnimations().filter((animation) => animation.playState === 'running');
  return running.map((animation) => {
    const timing = animation.effect?.getComputedTiming();
    return {
      name: animation.animationName ?? animation.transitionProperty ?? animation.constructor.name,
      kind: animation.constructor.name,
      target: path(animation.effect?.target),
      iterations:
        timing?.iterations === Number.POSITIVE_INFINITY ? 'infinite' : (timing?.iterations ?? 1),
      durationMs: typeof timing?.duration === 'number' ? Math.round(timing.duration) : null,
    };
  });
}

/** CSS the page ships for motion and orientation: rule counts, readable only for same-origin sheets. */
export function collectMediaRules() {
  let reducedMotion = 0;
  let orientation = 0;
  let unreadable = 0;
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.media) {
        const text = rule.media.mediaText;
        if (/prefers-reduced-motion/.test(text)) reducedMotion += 1;
        if (/orientation/.test(text)) orientation += 1;
      }
      if (rule.cssRules) visit(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      unreadable += 1;
    }
  }
  return {
    reducedMotionRules: reducedMotion,
    orientationRules: orientation,
    unreadableSheets: unreadable,
  };
}

/** Forms: the label and error wiring that axe checks only in part, and the autocomplete tokens. */
export function collectForms() {
  const path = (element) =>
    [
      element.tagName.toLowerCase(),
      ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
    ].join('.');
  const textOf = (element) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const labelFor = (field) => {
    const labelledBy = field.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .join(' ')
        .trim();
      if (text) return text;
    }
    const aria = field.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    if (field.labels?.length) return [...field.labels].map(textOf).join(' ').trim();
    return field.getAttribute('title')?.trim() ?? '';
  };

  const fields = [];
  const invalid = [];
  const controls = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea',
  );
  for (const field of controls) {
    if (
      typeof field.checkVisibility === 'function' &&
      !field.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const label = labelFor(field);
    const described = (field.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(document.getElementById(id)))
      .filter(Boolean);
    fields.push({
      target: path(field),
      type: field.type ?? field.tagName.toLowerCase(),
      label,
      hasLabel: label !== '',
      autocomplete: field.getAttribute('autocomplete') ?? '',
      required: field.required || field.getAttribute('aria-required') === 'true',
      paste: !field.matches('[onpaste]'),
    });
    if (field.getAttribute('aria-invalid') === 'true') {
      const errorId = field.getAttribute('aria-errormessage');
      const hasError =
        described.length > 0 || (errorId && textOf(document.getElementById(errorId)) !== '');
      invalid.push({ target: path(field), hasAssociatedMessage: Boolean(hasError) });
    }
  }

  const live = [
    ...document.querySelectorAll(
      '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]',
    ),
  ].map((element) => ({
    target: path(element),
    role: element.getAttribute('role'),
    live: element.getAttribute('aria-live'),
    hasText: textOf(element) !== '',
  }));
  return { fields, invalid, live };
}

/** The document-level facts: title, language, landmarks, headings, skip link. */
export function collectDocument() {
  const path = (element) =>
    [
      element.tagName.toLowerCase(),
      ...[...element.classList].filter((name) => !/[[\]:/]/.test(name)).slice(0, 2),
    ].join('.');
  const landmarkRoles = {
    main: 'main, [role="main"]',
    banner: 'body > header, [role="banner"]',
    navigation: 'nav, [role="navigation"]',
    complementary: 'aside, [role="complementary"]',
    contentinfo: 'body > footer, [role="contentinfo"]',
    search: '[role="search"]',
    region:
      '[role="region"][aria-label], [role="region"][aria-labelledby], section[aria-label], section[aria-labelledby]',
  };
  const landmarks = {};
  for (const [role, selector] of Object.entries(landmarkRoles)) {
    landmarks[role] = [...document.querySelectorAll(selector)]
      .filter(
        (element) =>
          typeof element.checkVisibility !== 'function' ||
          element.checkVisibility({ visibilityProperty: true }),
      )
      .map((element) => ({
        target: path(element),
        label:
          element.getAttribute('aria-label') ??
          (element.getAttribute('aria-labelledby') ? 'labelledby' : ''),
      }));
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .filter(
      (element) =>
        typeof element.checkVisibility !== 'function' ||
        element.checkVisibility({ visibilityProperty: true }),
    )
    .map((element) => ({
      level: element.getAttribute('aria-level')
        ? Number(element.getAttribute('aria-level'))
        : Number(element.tagName.slice(1)) || 2,
      empty: (element.textContent ?? '').trim() === '',
    }));
  const first = document.querySelector('a[href^="#"]');
  return {
    title: document.title,
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    landmarks,
    headings,
    skipLink: first
      ? { href: first.getAttribute('href'), text: (first.textContent ?? '').trim().slice(0, 40) }
      : null,
    viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
  };
}

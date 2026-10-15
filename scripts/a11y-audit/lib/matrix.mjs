/**
 * What the audit covers: which contexts (role, theme, accent, view, language) are visited, which
 * routes each role can reach, and which checks run in a context.
 *
 * A full cartesian product of everything the spec names is thousands of page loads, so there are
 * three profiles, and the one that ran is written into evidence.json:
 *
 *   full      every combination (hours; for a release)
 *   standard  one dimension at a time from the baseline (light, first accent, 1280 px, English):
 *             every theme with every accent, every view in both themes, every other language at
 *             desktop and at 320 px in both themes
 *   smoke     the baseline plus one step along each dimension (minutes; for trying the tool)
 */

export const VIEWS = {
  1280: { width: 1280, height: 800 },
  768: { width: 768, height: 1024 },
  320: { width: 320, height: 640 },
  // 400% zoom of a 1280 px window is a 320 CSS px window; 256 is 1024 / 4.
  zoom400: { width: 320, height: 256, deviceScaleFactor: 4 },
  // Text at 200%: the root font size is doubled in the page (checks/measured.mjs).
  text200: { width: 1280, height: 800 },
  // The prefers-reduced-motion media query turned on.
  reduce: { width: 1280, height: 800, reducedMotion: 'reduce' },
};

export const PROFILES = ['smoke', 'standard', 'full'];

const AUDIENCES_FOR = {
  anonymous: ['public'],
  user: ['end-user'],
  restricted: ['end-user'],
  admin: ['end-user', 'admin'],
};

/** The pages a role can open: no redirects (checked separately), no state-only pages. */
export function routesForRole(routes, role) {
  const audiences = AUDIENCES_FOR[role];
  if (!audiences) throw new Error(`Unknown role ${role}`);
  return routes.filter(
    (route) =>
      !route.state &&
      // The not-found page is shown to everyone, inside or outside the app shell.
      (route.kind === 'notfound' || (route.kind === 'page' && audiences.includes(route.audience))),
  );
}

function context(role, theme, accent, viewport, language) {
  return { role, theme, accent, viewport, language };
}

/**
 * @param {{ profile: string, roles: string[], themes: string[], accents: string[], views: string[], languages: string[] }} input
 */
export function buildMatrix({ profile, roles, themes, accents, views, languages }) {
  if (!PROFILES.includes(profile))
    throw new Error(`Unknown profile "${profile}": use ${PROFILES.join(', ')}`);
  for (const view of views) {
    if (!VIEWS[view])
      throw new Error(`Unknown view "${view}": use ${Object.keys(VIEWS).join(', ')}`);
  }
  const [theme0] = themes;
  const [accent0] = accents;
  const [view0] = views;
  const [language0] = languages;
  const others = languages.slice(1);
  const out = new Map();
  const add = (...args) => {
    const entry = context(...args);
    out.set(JSON.stringify(entry), entry);
  };

  for (const role of roles) {
    if (profile === 'full') {
      for (const accent of accents)
        for (const theme of themes)
          for (const view of views)
            for (const language of languages) add(role, theme, accent, view, language);
    } else if (profile === 'standard') {
      for (const theme of themes)
        for (const accent of accents) add(role, theme, accent, view0, language0);
      for (const view of views)
        for (const theme of themes) add(role, theme, accent0, view, language0);
      for (const language of others) {
        for (const theme of themes) {
          add(role, theme, accent0, view0, language);
          if (views.includes('320')) add(role, theme, accent0, '320', language);
        }
      }
    } else {
      add(role, theme0, accent0, view0, language0);
      if (themes[1]) add(role, themes[1], accent0, view0, language0);
      if (accents[1]) add(role, theme0, accents[1], view0, language0);
      for (const view of ['320', 'zoom400', 'text200', 'reduce']) {
        if (views.includes(view)) add(role, theme0, accent0, view, language0);
      }
      if (others[0]) add(role, theme0, accent0, view0, others[0]);
    }
  }
  // Grouped by accent, which is an instance setting the runner changes between groups.
  return [...out.values()].sort((a, b) => accents.indexOf(a.accent) - accents.indexOf(b.accent));
}

/**
 * The checks to run for a context. Colour-dependent checks repeat in every theme and accent;
 * layout-dependent ones run once per view; what depends on neither (the accessibility tree,
 * forms, document facts) runs once.
 *
 * @param {{ viewport: string, theme: string, accent: string, themes: string[], accents: string[] }} input
 */
export function checksFor({ viewport, theme, accent, themes, accents }) {
  const base = theme === themes[0] && accent === accents[0];
  if (viewport === 'zoom400') return ['reflow'];
  if (viewport === 'text200') return ['text-resize'];
  if (viewport === 'reduce') return ['motion'];
  const checks = ['axe', 'contrast', 'non-text', 'targets'];
  if (base && viewport === '1280')
    checks.push('text-spacing', 'tree', 'forms', 'document', 'motion');
  if (base && viewport === '320') checks.push('reflow', 'text-spacing');
  return checks;
}

/**
 * What evidence decides each criterion, and how the Revised Section 508 and EN 301 549 tables are
 * derived from the WCAG rows.
 *
 * Nothing here states a result. It states which checks are this project's test for a criterion
 * (`DECISIVE`: a clean run of those checks is enough to say "Supports", within the stated
 * scope) and which criteria only an inspection can settle. Every other criterion is "Not
 * Evaluated" until a person records an inspection in inspections.md, however many automated
 * samples passed: an automated check passing is not conformance.
 */

export const STATUSES = [
  'Supports',
  'Partially Supports',
  'Does Not Support',
  'Not Applicable',
  'Not Evaluated',
];

/**
 * Criteria the audit's measurements decide, with the checks that must have run and the scope the
 * remark states. A criterion not listed here is never "Supports" on automated evidence alone.
 *
 * @type {Record<string, { checks: string[], scope: string }>}
 */
export const DECISIVE = {
  '1.3.5': {
    checks: ['forms'],
    scope:
      "the autocomplete token of every field on the pages that collect the person's own details (sign-in, sign-up, password reset, invitation, two-step verification, account settings)",
  },
  '1.4.3': {
    checks: ['contrast', 'axe'],
    scope:
      'the computed colour of every piece of rendered text over the background colour of its element and ancestors, in the themes and accents that ran (see the matrix above); text over images or gradients is not judged and is counted separately',
  },
  '1.4.4': {
    checks: ['text-resize', 'document'],
    scope:
      "each page with the root font size doubled (not the browser's zoom control), checked for clipped and overlapping text, and the viewport tag allowing zoom",
  },
  '1.4.10': {
    checks: ['reflow'],
    scope:
      'each page at 320 CSS px wide and at a 320 by 256 px window at a device scale of 4 (400% zoom of 1280 by 1024)',
  },
  '1.4.12': {
    checks: ['text-spacing'],
    scope:
      'each page with the four text-spacing properties of 1.4.12 applied, checked for newly clipped and newly overlapping text',
  },
  '2.5.8': {
    checks: ['target-size'],
    scope:
      'the box of every pointer target, with the spacing, inline and user-agent exceptions applied by geometry (the equivalent and essential exceptions are not applied)',
  },
  '3.1.1': {
    checks: ['document'],
    scope:
      'the lang attribute of every page, compared with the language the page was asked to show',
  },
  '3.3.8': {
    checks: ['forms', 'walkthrough'],
    scope:
      'paste into every password and code field, the autocomplete token of the code field, and the absence of any puzzle, on the pages where this run found such a field (the routes counted)',
  },
};

/** Criteria whose automated evidence is only part of the test: the remark says so. */
export const PARTIAL_EVIDENCE = {
  '1.1.1':
    'axe checks that images, icons and controls have a text alternative, not that it is accurate',
  '1.3.1':
    'axe and the accessibility tree check structure and labels, not whether the structure is the right one',
  '1.4.11':
    'the edge of fields, the glyph of icon-only controls and the focus indicator are measured; charts and other graphics are not',
  '2.1.1':
    'the primary tasks listed in the methods were completed with the keyboard alone; other functions were not walked',
  '2.1.2':
    'the tab order of the pages in the walkthroughs was walked for traps; other pages were not',
  '2.4.1': 'landmarks on every page and the skip link where the walkthroughs loaded the page',
  '2.4.2': 'every page has a non-empty title; whether it describes the page is a judgement',
  '2.4.3': 'the tab order of the walked pages and the focus behaviour of two dialogs',
  '2.4.7': 'the focus indicator at every tab stop of the walked pages',
  '2.4.11': 'every tab stop of the walked pages against fixed and sticky content',
  '3.2.6':
    'five pages were searched for a link or button named help, contact, support, feedback or documentation; where a help mechanism is repeated is for an inspection',
  '4.1.2': "the accessibility tree's names and states, not what a screen reader says",
  '4.1.3':
    'live regions observed while a reply streamed, failed and was stopped; not every status message',
};

/** WCAG 2.0 criteria only: what the Revised Section 508 incorporates. Added later: see ADDED_IN. */
export const ADDED_IN = {
  '1.3.4': '2.1',
  '1.3.5': '2.1',
  '1.4.10': '2.1',
  '1.4.11': '2.1',
  '1.4.12': '2.1',
  '1.4.13': '2.1',
  '2.1.4': '2.1',
  '2.5.1': '2.1',
  '2.5.2': '2.1',
  '2.5.3': '2.1',
  '2.5.4': '2.1',
  '4.1.3': '2.1',
  '2.4.11': '2.2',
  '2.5.7': '2.2',
  '2.5.8': '2.2',
  '3.2.6': '2.2',
  '3.3.7': '2.2',
  '3.3.8': '2.2',
};

const range = (...ids) => ids;

/**
 * Revised Section 508, Chapter 3 (functional performance criteria): the WCAG criteria each is
 * derived from. This mapping is this project's reading, written down so a reader can disagree
 * with it; where nothing maps, the row is "Not Evaluated", not "Supports".
 */
export const FPC_508 = [
  [
    '302.1',
    'Without Vision',
    range(
      '1.1.1',
      '1.2.1',
      '1.2.2',
      '1.2.3',
      '1.2.5',
      '1.3.1',
      '1.3.2',
      '1.3.3',
      '1.4.1',
      '1.4.2',
      '2.1.1',
      '2.1.2',
      '2.4.1',
      '2.4.2',
      '2.4.3',
      '2.4.4',
      '2.4.6',
      '3.1.1',
      '3.2.1',
      '3.2.2',
      '3.3.1',
      '3.3.2',
      '4.1.2',
      '4.1.3',
    ),
  ],
  [
    '302.2',
    'With Limited Vision',
    range(
      '1.3.4',
      '1.4.3',
      '1.4.4',
      '1.4.5',
      '1.4.10',
      '1.4.11',
      '1.4.12',
      '1.4.13',
      '2.4.7',
      '2.4.11',
    ),
  ],
  ['302.3', 'Without Perception of Color', range('1.4.1', '1.4.3', '1.4.11')],
  ['302.4', 'Without Hearing', range('1.2.1', '1.2.2', '1.2.4')],
  ['302.5', 'With Limited Hearing', range('1.2.1', '1.2.2', '1.2.4', '1.4.2')],
  ['302.6', 'Without Speech', []],
  [
    '302.7',
    'With Limited Manipulation',
    range('2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.5.1', '2.5.2', '2.5.4', '2.5.7', '2.5.8'),
  ],
  ['302.8', 'With Limited Reach and Strength', range('2.1.1', '2.1.2', '2.5.8')],
  [
    '302.9',
    'With Limited Language, Cognitive, and Learning Abilities',
    range(
      '2.2.1',
      '2.2.2',
      '2.4.3',
      '2.4.6',
      '3.1.1',
      '3.1.2',
      '3.2.1',
      '3.2.2',
      '3.2.3',
      '3.2.4',
      '3.2.6',
      '3.3.1',
      '3.3.2',
      '3.3.3',
      '3.3.4',
      '3.3.7',
      '3.3.8',
    ),
  ],
];

/** EN 301 549 V3.2.1 clause 4 (functional performance statements), from the same criteria. */
export const FPS_EN = [
  ['4.2.1', 'Usage without vision', '302.1'],
  ['4.2.2', 'Usage with limited vision', '302.2'],
  ['4.2.3', 'Usage without perception of colour', '302.3'],
  ['4.2.4', 'Usage without hearing', '302.4'],
  ['4.2.5', 'Usage with limited hearing', '302.5'],
  ['4.2.6', 'Usage without vocal capability', '302.6'],
  ['4.2.7', 'Usage with limited manipulation or strength', '302.7'],
  ['4.2.8', 'Usage with limited reach', '302.8'],
  ['4.2.9', 'Minimize photosensitive seizure triggers', null, ['2.3.1']],
  ['4.2.10', 'Usage with limited cognition, language or learning', '302.9'],
  ['4.2.11', 'Privacy', null, []],
];

/** Rows that apply to hardware, which OCI is not: a scope statement, not a finding. */
export const HARDWARE_508 =
  'Chapter 4 (Hardware) applies to physical products. Open Chat Interface is software.';

/**
 * Combines the statuses of the rows a derived row is built from. A failure anywhere is at best
 * "Partially Supports"; anything not evaluated keeps the row "Not Evaluated"; "Not Applicable"
 * rows are left out, and a row built only from them is "Not Applicable".
 *
 * @param {string[]} statuses
 */
export function combine(statuses) {
  if (statuses.length === 0) return 'Not Evaluated';
  const counted = statuses.filter((status) => status !== 'Not Applicable');
  if (counted.length === 0) return 'Not Applicable';
  const failing = counted.filter(
    (status) => status === 'Partially Supports' || status === 'Does Not Support',
  );
  if (failing.length > 0) {
    return counted.every((status) => status === 'Does Not Support')
      ? 'Does Not Support'
      : 'Partially Supports';
  }
  if (counted.some((status) => status === 'Not Evaluated')) return 'Not Evaluated';
  return 'Supports';
}

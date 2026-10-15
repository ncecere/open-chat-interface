/**
 * The WCAG 2.2 level A and AA success criteria, and how axe's tags name them.
 *
 * The conformance report has one row per criterion here, in this order. Level AAA is not
 * listed: the report says it was not evaluated (WCAG 2.2 has 31 A and 24 AA criteria once
 * 4.1.1, removed in 2.2, is set aside).
 */

/** @type {ReadonlyArray<{ id: string, level: 'A' | 'AA', name: string }>} */
export const CRITERIA = [
  { id: '1.1.1', level: 'A', name: 'Non-text Content' },
  { id: '1.2.1', level: 'A', name: 'Audio-only and Video-only (Prerecorded)' },
  { id: '1.2.2', level: 'A', name: 'Captions (Prerecorded)' },
  { id: '1.2.3', level: 'A', name: 'Audio Description or Media Alternative (Prerecorded)' },
  { id: '1.2.4', level: 'AA', name: 'Captions (Live)' },
  { id: '1.2.5', level: 'AA', name: 'Audio Description (Prerecorded)' },
  { id: '1.3.1', level: 'A', name: 'Info and Relationships' },
  { id: '1.3.2', level: 'A', name: 'Meaningful Sequence' },
  { id: '1.3.3', level: 'A', name: 'Sensory Characteristics' },
  { id: '1.3.4', level: 'AA', name: 'Orientation' },
  { id: '1.3.5', level: 'AA', name: 'Identify Input Purpose' },
  { id: '1.4.1', level: 'A', name: 'Use of Color' },
  { id: '1.4.2', level: 'A', name: 'Audio Control' },
  { id: '1.4.3', level: 'AA', name: 'Contrast (Minimum)' },
  { id: '1.4.4', level: 'AA', name: 'Resize Text' },
  { id: '1.4.5', level: 'AA', name: 'Images of Text' },
  { id: '1.4.10', level: 'AA', name: 'Reflow' },
  { id: '1.4.11', level: 'AA', name: 'Non-text Contrast' },
  { id: '1.4.12', level: 'AA', name: 'Text Spacing' },
  { id: '1.4.13', level: 'AA', name: 'Content on Hover or Focus' },
  { id: '2.1.1', level: 'A', name: 'Keyboard' },
  { id: '2.1.2', level: 'A', name: 'No Keyboard Trap' },
  { id: '2.1.4', level: 'A', name: 'Character Key Shortcuts' },
  { id: '2.2.1', level: 'A', name: 'Timing Adjustable' },
  { id: '2.2.2', level: 'A', name: 'Pause, Stop, Hide' },
  { id: '2.3.1', level: 'A', name: 'Three Flashes or Below Threshold' },
  { id: '2.4.1', level: 'A', name: 'Bypass Blocks' },
  { id: '2.4.2', level: 'A', name: 'Page Titled' },
  { id: '2.4.3', level: 'A', name: 'Focus Order' },
  { id: '2.4.4', level: 'A', name: 'Link Purpose (In Context)' },
  { id: '2.4.5', level: 'AA', name: 'Multiple Ways' },
  { id: '2.4.6', level: 'AA', name: 'Headings and Labels' },
  { id: '2.4.7', level: 'AA', name: 'Focus Visible' },
  { id: '2.4.11', level: 'AA', name: 'Focus Not Obscured (Minimum)' },
  { id: '2.5.1', level: 'A', name: 'Pointer Gestures' },
  { id: '2.5.2', level: 'A', name: 'Pointer Cancellation' },
  { id: '2.5.3', level: 'A', name: 'Label in Name' },
  { id: '2.5.4', level: 'A', name: 'Motion Actuation' },
  { id: '2.5.7', level: 'AA', name: 'Dragging Movements' },
  { id: '2.5.8', level: 'AA', name: 'Target Size (Minimum)' },
  { id: '3.1.1', level: 'A', name: 'Language of Page' },
  { id: '3.1.2', level: 'AA', name: 'Language of Parts' },
  { id: '3.2.1', level: 'A', name: 'On Focus' },
  { id: '3.2.2', level: 'A', name: 'On Input' },
  { id: '3.2.3', level: 'AA', name: 'Consistent Navigation' },
  { id: '3.2.4', level: 'AA', name: 'Consistent Identification' },
  { id: '3.2.6', level: 'A', name: 'Consistent Help' },
  { id: '3.3.1', level: 'A', name: 'Error Identification' },
  { id: '3.3.2', level: 'A', name: 'Labels or Instructions' },
  { id: '3.3.3', level: 'AA', name: 'Error Suggestion' },
  { id: '3.3.4', level: 'AA', name: 'Error Prevention (Legal, Financial, Data)' },
  { id: '3.3.7', level: 'A', name: 'Redundant Entry' },
  { id: '3.3.8', level: 'AA', name: 'Accessible Authentication (Minimum)' },
  { id: '4.1.2', level: 'A', name: 'Name, Role, Value' },
  { id: '4.1.3', level: 'AA', name: 'Status Messages' },
];

const BY_DIGITS = new Map(
  CRITERIA.map((criterion) => [criterion.id.replaceAll('.', ''), criterion.id]),
);

/**
 * axe tags a rule `wcag143` for 1.4.3, `wcag2411` for 2.4.11. The digits run together, so the
 * criterion is found by looking the string up in the list above: there is no other reading of
 * `1410` than 1.4.10. Tags that are not a criterion (`wcag2a`, `wcag22aa`, `cat.color`) and
 * criteria this report does not cover (level AAA, 4.1.1) give `null`.
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function criterionFromAxeTag(tag) {
  const match = /^wcag(\d{3,4})$/.exec(tag);
  return match ? (BY_DIGITS.get(match[1]) ?? null) : null;
}

/** The criteria an axe rule is evidence for, from its tags. */
export function criteriaFromAxeTags(tags) {
  return [...new Set(tags.map(criterionFromAxeTag).filter(Boolean))];
}

export function criterion(id) {
  return CRITERIA.find((candidate) => candidate.id === id) ?? null;
}

/** Orders `1.4.3` before `1.4.10`, which a string sort does not. */
export function compareCriteria(one, two) {
  const left = one.split('.').map(Number);
  const right = two.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** The axe tag set the audit scans with; the same as the e2e helper's WCAG_22_AA. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

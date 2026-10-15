/**
 * WCAG 1.3.5 Identify Input Purpose, as pure functions of what a field says about itself.
 *
 * The check runs on pages that collect the person's own details (sign-in, sign-up, account
 * settings). A field whose purpose is known from its type, or from its label when it carries
 * one of a short list of unambiguous names, must say so with an `autocomplete` token. A field
 * about someone else (an administrator creating an account) is out of 1.3.5's scope, which
 * is why routes.json marks the pages this is run on.
 */

const STANDALONE = [
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'honorific-suffix',
  'nickname',
  'username',
  'new-password',
  'current-password',
  'organization-title',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-line3',
  'address-level4',
  'address-level3',
  'address-level2',
  'address-level1',
  'country',
  'country-name',
  'postal-code',
  'cc-name',
  'cc-given-name',
  'cc-additional-name',
  'cc-family-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-type',
  'transaction-currency',
  'transaction-amount',
  'language',
  'bday',
  'bday-day',
  'bday-month',
  'bday-year',
  'sex',
  'url',
  'photo',
  'one-time-code',
];

/** Valid only after a contact-kind token (`home`, `work`, …), which HTML allows for these. */
const QUALIFIED = [
  'tel',
  'tel-country-code',
  'tel-national',
  'tel-area-code',
  'tel-local',
  'tel-local-prefix',
  'tel-local-suffix',
  'tel-extension',
  'email',
  'impp',
];

export const INPUT_PURPOSES = [...STANDALONE, ...QUALIFIED];

const CONTACT_KINDS = ['home', 'work', 'mobile', 'fax', 'pager'];
const ADDRESS_KINDS = ['shipping', 'billing'];

/**
 * Reads an `autocomplete` value: optional `section-*`, optional shipping or billing, optional
 * contact kind, one purpose, optional `webauthn`. `off` and `on` are valid and name no purpose.
 *
 * @returns {{ valid: boolean, purpose: string | null, empty?: boolean }}
 */
export function parseAutocomplete(value) {
  const tokens = String(value ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return { valid: false, purpose: null, empty: true };
  if (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off')) {
    return { valid: true, purpose: null };
  }
  const rest = [...tokens];
  if (rest.at(-1) === 'webauthn') rest.pop();
  if (rest[0]?.startsWith('section-')) rest.shift();
  if (ADDRESS_KINDS.includes(rest[0])) rest.shift();
  const contact = CONTACT_KINDS.includes(rest[0]) ? rest.shift() : null;
  if (rest.length !== 1) return { valid: false, purpose: null };
  const [purpose] = rest;
  if (STANDALONE.includes(purpose) && !contact) return { valid: true, purpose };
  if (QUALIFIED.includes(purpose)) return { valid: true, purpose };
  return { valid: false, purpose: null };
}

/**
 * The tokens that would be right for a field, or `null` when nothing is known about it. Types
 * decide first; a text field is judged only by a label that names an unambiguous purpose.
 *
 * @param {{ type?: string, label?: string, name?: string }} field
 * @returns {string[] | null}
 */
export function expectedPurposes(field) {
  const type = (field.type ?? 'text').toLowerCase();
  const label = (field.label ?? '').trim().toLowerCase();
  if (type === 'email') return ['email', 'username'];
  if (type === 'password') return ['current-password', 'new-password'];
  if (type === 'tel') return ['tel'];
  if (type === 'text' || type === '' || type === 'number') {
    if (/\b(authentication|verification|security|one-time)\s+code\b/.test(label)) {
      return ['one-time-code'];
    }
    if (/^(your |full )?name$/.test(label)) return ['name', 'given-name'];
    if (/^(user ?name)$/.test(label)) return ['username'];
  }
  return null;
}

/**
 * @param {Array<{ id: string, type?: string, label?: string, autocomplete?: string }>} fields
 * @returns {Array<{ id: string, problem: 'missing' | 'invalid' | 'wrong-purpose', expected: string[], actual: string }>}
 */
export function evaluateAutocomplete(fields) {
  const findings = [];
  for (const field of fields) {
    const expected = expectedPurposes(field);
    if (!expected) continue;
    const actual = String(field.autocomplete ?? '');
    const parsed = parseAutocomplete(actual);
    let problem = null;
    if (parsed.empty || (parsed.valid && parsed.purpose === null)) problem = 'missing';
    else if (!parsed.valid) problem = 'invalid';
    else if (!expected.includes(parsed.purpose)) problem = 'wrong-purpose';
    if (problem) findings.push({ id: field.id, problem, expected, actual });
  }
  return findings;
}
